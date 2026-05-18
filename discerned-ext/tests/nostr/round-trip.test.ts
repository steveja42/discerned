import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createQuoteNoteEvent,
  createResourceNoteEvent,
  finalizeEventWithPrivateKey,
} from '@/shared/nostr/events';
import type { Capture, Evaluation } from '@/shared/types';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';

const CLIPS_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'clips');
const DETERMINISTIC_SK = new Uint8Array(32).fill(0x01);

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

function buildTemplate(capture: Capture, evaluation: Evaluation): EventTemplate {
  if (capture.format === 'selection') return createQuoteNoteEvent(capture, evaluation);
  return createResourceNoteEvent(capture, evaluation, capture.bodyText);
}

function sortedTags(ev: NostrEvent): string[] {
  return ev.tags.map((t) => JSON.stringify(t)).sort();
}

describe('Nostr serialize → re-serialize tag stability', () => {
  it.each(fixtures)('$name: re-serializing yields the same tag set', ({ capture, evaluation }) => {
    const a = finalizeEventWithPrivateKey(buildTemplate(capture, evaluation), DETERMINISTIC_SK);
    const b = finalizeEventWithPrivateKey(buildTemplate(capture, evaluation), DETERMINISTIC_SK);
    expect(sortedTags(a)).toEqual(sortedTags(b));
    expect(a.content).toBe(b.content);
  });
});
