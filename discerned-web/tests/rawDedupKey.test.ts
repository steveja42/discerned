// rawDedupKey (feed.ts) operates on raw relay Events, before parseEvent turns
// them into ClipData for dedupKey (useCastFeed.ts). The backfill walk in
// subscribeFeed counts in rawDedupKey's unit specifically so it stops paging
// once enough DISTINCT CLIPS have been collected, not raw events — a page of
// 50 events is only ~25 clips once note/long-form pairs collapse. If the two
// key functions ever disagree, that count goes wrong again silently, so this
// asserts they produce the same key for the same event, via parseEvent.

import { describe, it, expect } from 'vitest';
import type { Event } from 'nostr-tools';
import { rawDedupKey } from '@/lib/nostr/feed';
import { dedupKey } from '@/hooks/useCastFeed';
import { parseEvent } from '@/lib/nostr/parse';

const PK = 'a'.repeat(64);
const OTHER_PK = 'b'.repeat(64);

function makeNote(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-note',
    pubkey: PK,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [['t', 'discerned'], ['r', 'https://example.com/a'], ['a', `30023:${PK}:clip-uuid-1`]],
    content: 'The Article\nhttps://example.com/a',
    sig: 'sig',
    ...overrides,
  };
}

function makeLongForm(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-longform',
    pubkey: PK,
    created_at: 1_700_000_000,
    kind: 30023,
    tags: [['t', 'discerned'], ['d', 'clip-uuid-1'], ['title', 'The Article']],
    content: '# The Article',
    sig: 'sig',
    ...overrides,
  };
}

describe('rawDedupKey', () => {
  it('agrees with dedupKey for a note/long-form pair', () => {
    const note = makeNote();
    const longForm = makeLongForm();
    expect(rawDedupKey(note)).toBe(dedupKey(parseEvent(note)));
    expect(rawDedupKey(longForm)).toBe(dedupKey(parseEvent(longForm)));
    expect(rawDedupKey(note)).toBe(rawDedupKey(longForm));
  });

  it('agrees with dedupKey for a standalone note (no companion long-form)', () => {
    const standalone = makeNote({ id: 'evt-standalone', tags: [['t', 'discerned'], ['r', 'https://example.com/b']] });
    expect(rawDedupKey(standalone)).toBe(dedupKey(parseEvent(standalone)));
    expect(rawDedupKey(standalone)).toBe('evt-standalone');
  });

  it('keys differ across authors even with the same longFormId', () => {
    const mine = makeLongForm();
    const someoneElses = makeLongForm({ id: 'evt-other', pubkey: OTHER_PK });
    expect(rawDedupKey(mine)).not.toBe(rawDedupKey(someoneElses));
  });
});
