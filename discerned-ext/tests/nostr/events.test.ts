import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createQuoteNoteEvent,
  createResourceNoteEvent,
  finalizeEventWithPrivateKey,
  validateEvent,
  extractTagValue,
  extractTagValues,
} from '@/shared/nostr/events';
import type { Capture, Evaluation, ClipFormat } from '@/shared/types';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';

const CLIPS_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'clips');

interface ClipFixture {
  name: string;
  capture: Capture;
  evaluation: Evaluation;
}

const fixtures: ClipFixture[] = readdirSync(CLIPS_ROOT)
  .filter((f) => f.endsWith('.json'))
  .map((file) => {
    const data = JSON.parse(readFileSync(resolve(CLIPS_ROOT, file), 'utf8')) as
      { capture: Capture; evaluation: Evaluation };
    return { name: file, ...data };
  });

// Deterministic 32-byte secret key so signatures are reproducible across runs.
const DETERMINISTIC_SK = new Uint8Array(32).fill(0x01);

function buildTemplate(capture: Capture, evaluation: Evaluation): EventTemplate {
  if (capture.format === 'selection') return createQuoteNoteEvent(capture, evaluation);
  return createResourceNoteEvent(capture, evaluation, capture.bodyText);
}

describe('Nostr event factory', () => {
  for (const fx of fixtures) {
    describe(`fixture: ${fx.name}`, () => {
      let event: NostrEvent;

      it('signs into a valid kind:1 event', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        event = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
        expect(validateEvent(event)).toBe(true);
        expect(event.kind).toBe(1);
      });

      it('emits the canonical Discerned tags', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);

        // Required tags
        expect(extractTagValue(ev, 'r')).toBe(fx.capture.url);
        expect(extractTagValue(ev, 't')).toBe('discerned');
        expect(extractTagValue(ev, 'client')).toBe('discerned');
        expect(extractTagValue(ev, 'format')).toBe(fx.capture.format satisfies ClipFormat);

        // The three label namespaces, each with both an L (namespace declaration) and l (labeled value)
        const lTags = ev.tags.filter((t) => t[0] === 'l');
        const interestTag = lTags.find((t) => t[2] === 'online.discerned.interest');
        const ethicsTag = lTags.find((t) => t[2] === 'online.discerned.ethics');
        const categoryTag = lTags.find((t) => t[2] === 'online.discerned.category');
        expect(interestTag?.[1]).toBe(fx.evaluation.interest);
        expect(ethicsTag?.[1]).toBe(fx.evaluation.ethics);
        expect(categoryTag?.[1]).toBe(fx.evaluation.category);

        const LDeclarations = extractTagValues(ev, 'L');
        expect(LDeclarations).toEqual(
          expect.arrayContaining([
            'online.discerned.interest',
            'online.discerned.ethics',
            'online.discerned.category',
          ]),
        );
      });

      it('emits format-specific tags', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);

        if (fx.capture.format === 'selection') {
          expect(extractTagValue(ev, 'quote')).toBe(fx.capture.selectionText ?? '');
          if (fx.capture.selectionContext) {
            expect(extractTagValue(ev, 'context')).toBe(fx.capture.selectionContext);
          }
        } else {
          if (fx.capture.thumbnail) {
            expect(extractTagValue(ev, 'image')).toBe(fx.capture.thumbnail);
          }
          if (fx.capture.bodyText) {
            // body tag exists only when caller passed an inlineBody; we always do for tests.
            expect(extractTagValue(ev, 'body')).toBe(fx.capture.bodyText);
          }
        }

        if (fx.capture.note && fx.capture.note.trim().length > 0) {
          expect(extractTagValue(ev, 'note')).toBe(fx.capture.note);
        }
      });

      it('preserves capture.timestamp on the event (seconds resolution)', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
        expect(ev.created_at).toBe(Math.floor(fx.capture.timestamp / 1000));
      });
    });
  }

  it('rejects createQuoteNoteEvent on non-selection captures', () => {
    const article = fixtures.find((f) => f.capture.format === 'article');
    if (!article) throw new Error('no article fixture');
    expect(() => createQuoteNoteEvent(article.capture, article.evaluation)).toThrow();
  });

  it('rejects createResourceNoteEvent on selection captures', () => {
    const sel = fixtures.find((f) => f.capture.format === 'selection');
    if (!sel) throw new Error('no selection fixture');
    expect(() => createResourceNoteEvent(sel.capture, sel.evaluation)).toThrow();
  });
});
