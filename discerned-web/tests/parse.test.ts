// Verifies that the web app's parseEvent() correctly reverses what the
// extension's event factory produces. Cross-package consistency is the whole
// point of these tests — drift here breaks the public feed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/core';
import { parseEvent } from '@/lib/nostr/parse';
import { SIGNAL_LEVELS } from '@/lib/constants';
import type { Capture, Evaluation } from '@/lib/types';

// First content line, mirroring evaluationSummary in the extension's events.ts.
function summaryLine(evaluation: Evaluation): string {
  if (!evaluation.signal) return `Discerned: ${evaluation.category}`;
  const rank = (SIGNAL_LEVELS as readonly string[]).indexOf(evaluation.signal) + 1;
  return `Discerned: ${'★'.repeat(rank)} ${evaluation.signal} — ${evaluation.category}`;
}

// Build a Discerned kind:1 event template from a fixture. Implementation mirrors
// createQuoteNoteEvent / createResourceNoteEvent in discerned-ext/src/shared/nostr/events.ts.
// We rebuild the templates inline rather than importing across the package boundary
// to keep the web Vitest run self-contained (no relative reach into discerned-ext src/).
function buildTemplate(capture: Capture, evaluation: Evaluation): EventTemplate {
  const tags: string[][] = [
    ['r', capture.url],
    ['L', 'online.discerned.category'],
    ['l', evaluation.category, 'online.discerned.category'],
  ];
  if (evaluation.signal) {
    tags.push(['L', 'online.discerned.signal']);
    tags.push(['l', evaluation.signal, 'online.discerned.signal']);
  }
  if (evaluation.qualifiers && evaluation.qualifiers.length > 0) {
    tags.push(['L', 'online.discerned.qualifier']);
    for (const q of evaluation.qualifiers) tags.push(['l', q, 'online.discerned.qualifier']);
  }
  tags.push(['t', 'discerned'], ['format', capture.format], ['client', 'discerned']);

  if (capture.note && capture.note.trim().length > 0) {
    tags.push(['note', capture.note]);
  }

  let content: string;
  if (capture.format === 'selection') {
    const quoted = capture.selectionText ?? '';
    tags.push(['quote', quoted]);
    if (capture.selectionContext) tags.push(['context', capture.selectionContext]);
    content = [
      summaryLine(evaluation),
      `> "${quoted}"`,
      '',
      capture.url,
    ].join('\n');
  } else {
    if (capture.title && capture.title.trim().length > 0) tags.push(['title', capture.title]);
    if (capture.thumbnail) tags.push(['image', capture.thumbnail]);
    if (capture.bodyText) tags.push(['body', capture.bodyText]);
    content = [
      summaryLine(evaluation),
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
      expect(clip.evaluation.signal).toBe(fx.evaluation.signal);
      expect(clip.evaluation.qualifiers).toEqual(fx.evaluation.qualifiers ?? []);
      expect(clip.evaluation.category).toBe(fx.evaluation.category);

      if (fx.capture.format === 'selection') {
        expect(clip.capture.selectionText).toBe(fx.capture.selectionText);
        // Selection casts carry no title tag — parseEvent falls back to the URL.
        expect(clip.capture.title).toBe(fx.capture.url);
        if (fx.capture.selectionContext) {
          expect(clip.capture.selectionContext).toBe(fx.capture.selectionContext);
        }
      } else {
        // Resource casts emit an explicit `title` tag that round-trips exactly.
        expect(clip.capture.title).toBe(fx.capture.title);
        if (fx.capture.bodyText) expect(clip.capture.bodyText).toBe(fx.capture.bodyText);
        if (fx.capture.thumbnail) expect(clip.capture.thumbnail).toBe(fx.capture.thumbnail);
      }

      if (fx.capture.note) expect(clip.capture.note).toBe(fx.capture.note);
      expect(clip.capture.authorPubkey).toBe(ev.pubkey);
      expect(clip.capture.title).not.toMatch(/^Discerned:/);
      expect(clip.capture.timestamp).toBe(ev.created_at * 1000);
    });
  }

  it('extracts image URLs from NIP-92 imeta tags', () => {
    const photos = [
      'https://pbs.twimg.com/media/AAA?format=webp&name=medium',
      'https://pbs.twimg.com/media/BBB?format=webp&name=medium',
    ];
    const ev = finalizeEvent({
      kind: 1,
      created_at: 1_700_000_000,
      tags: [
        ['r', 'https://x.com/CIA/status/123'],
        ['format', 'article'],
        ['image', photos[0]],
        ['imeta', `url ${photos[0]}`, 'm image/webp'],
        ['imeta', `url ${photos[1]}`],
      ],
      content: 'Discerned: General\n\nCIA on X\nhttps://x.com/CIA/status/123',
    }, SK);

    const clip = parseEvent(ev);
    expect(clip.capture.imageUrls).toEqual(photos);
    // The single `image` tag still populates thumbnail for legacy renderers.
    expect(clip.capture.thumbnail).toBe(photos[0]);
  });

  it('leaves imageUrls undefined when there are no imeta tags', () => {
    const ev = finalizeEvent({
      kind: 1,
      created_at: 1_700_000_000,
      tags: [['r', 'https://example.com'], ['format', 'article']],
      content: 'Discerned: General\n\nTitle\nhttps://example.com',
    }, SK);
    expect(parseEvent(ev).capture.imageUrls).toBeUndefined();
  });

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
    expect(clip.evaluation.signal).toBeUndefined();
    expect(clip.evaluation.qualifiers).toEqual([]);
    expect(clip.evaluation.category).toBe('General');
  });

  it('ignores an unrecognized signal level', () => {
    const ev = finalizeEvent({
      kind: 1,
      created_at: 1_700_000_000,
      tags: [
        ['L', 'online.discerned.signal'],
        ['l', 'Stupendous', 'online.discerned.signal'],
        ['L', 'online.discerned.category'],
        ['l', 'General', 'online.discerned.category'],
      ],
      content: 'x',
    }, SK);

    const clip = parseEvent(ev);
    expect(clip.evaluation.signal).toBeUndefined();
    expect(clip.evaluation.category).toBe('General');
  });
});
