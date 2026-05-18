// Verifies that the web app's parseEvent() correctly reverses what the
// extension's event factory produces. Cross-package consistency is the whole
// point of these tests — drift here breaks the public feed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/core';
import { parseEvent } from '@/lib/nostr/parse';
import type { Capture, Evaluation } from '@/lib/types';

// Build a Discerned kind:1 event template from a fixture. Implementation mirrors
// createQuoteNoteEvent / createResourceNoteEvent in discerned-ext/src/shared/nostr/events.ts.
// We rebuild the templates inline rather than importing across the package boundary
// to keep the web Vitest run self-contained (no relative reach into discerned-ext src/).
function buildTemplate(capture: Capture, evaluation: Evaluation): EventTemplate {
  const tags: string[][] = [
    ['r', capture.url],
    ['L', 'online.discerned.interest'],
    ['L', 'online.discerned.ethics'],
    ['L', 'online.discerned.category'],
    ['l', evaluation.interest, 'online.discerned.interest'],
    ['l', evaluation.ethics, 'online.discerned.ethics'],
    ['l', evaluation.category, 'online.discerned.category'],
    ['t', 'discerned'],
    ['format', capture.format],
    ['client', 'discerned'],
  ];

  if (capture.note && capture.note.trim().length > 0) {
    tags.push(['note', capture.note]);
  }

  let content: string;
  if (capture.format === 'selection') {
    const quoted = capture.selectionText ?? '';
    tags.push(['quote', quoted]);
    if (capture.selectionContext) tags.push(['context', capture.selectionContext]);
    content = [
      `Discerned: ${evaluation.interest} / ${evaluation.ethics} — ${evaluation.category}`,
      `> "${quoted}"`,
      '',
      capture.url,
    ].join('\n');
  } else {
    if (capture.thumbnail) tags.push(['image', capture.thumbnail]);
    if (capture.bodyText) tags.push(['body', capture.bodyText]);
    content = [
      `Discerned: ${evaluation.interest} / ${evaluation.ethics} — ${evaluation.category}`,
      '',
      capture.title,
      capture.url,
    ].join('\n');
  }
  if (capture.note && capture.note.trim().length > 0) {
    content = `${content}\n\n— ${capture.note}`;
  }

  return {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content,
  };
}

const CLIPS_ROOT = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'clips');

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

const SK = generateSecretKey();

describe('parseEvent (web)', () => {
  for (const fx of fixtures) {
    it(`round-trips ${fx.name}`, () => {
      const ev = finalizeEvent(buildTemplate(fx.capture, fx.evaluation), SK);
      const clip = parseEvent(ev);

      expect(clip.capture.format).toBe(fx.capture.format);
      expect(clip.capture.url).toBe(fx.capture.url);
      expect(clip.evaluation.interest).toBe(fx.evaluation.interest);
      expect(clip.evaluation.ethics).toBe(fx.evaluation.ethics);
      expect(clip.evaluation.category).toBe(fx.evaluation.category);

      if (fx.capture.format === 'selection') {
        expect(clip.capture.selectionText).toBe(fx.capture.selectionText);
      }

      expect(clip.capture.title).toMatch(/^Discerned:/);
      expect(clip.capture.timestamp).toBe(ev.created_at * 1000);
    });
  }

  it('falls back to safe defaults when tags are missing', () => {
    const ev = finalizeEvent({
      kind: 1,
      created_at: 1_700_000_000,
      tags: [],
      content: 'A bare event\nwith just a title and a body',
    }, SK);

    const clip = parseEvent(ev);
    expect(clip.capture.url).toBe('');
    expect(clip.capture.format).toBe('bookmark');
    expect(clip.evaluation.interest).toBe('Neutral');
    expect(clip.evaluation.ethics).toBe('Neutral');
    expect(clip.evaluation.category).toBe('General');
  });
});
