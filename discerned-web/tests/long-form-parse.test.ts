// Verifies the web app ingests NIP-23 long-form (kind 30023) events, strips the
// "Discerned by …" attribution snippet, and joins a summary+link note to its
// companion long-form for dedup.

import { describe, it, expect } from 'vitest';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { parseEvent } from '@/lib/nostr/parse';
import {
  stripDiscernedSnippet,
  SNIPPET_SENTINEL_OPEN,
  SNIPPET_SENTINEL_CLOSE,
} from '@/lib/nostr/strip-snippet';

const SK = generateSecretKey();
const PK = getPublicKey(SK);
const snippet = (line: string) => `${SNIPPET_SENTINEL_OPEN}${line}${SNIPPET_SENTINEL_CLOSE}`;

describe('stripDiscernedSnippet', () => {
  it('removes the sentinel block and the blank line after it', () => {
    const content = `${snippet('Discerned by nostr:npub1abc — Tech · Worthwhile')}\n\nReal body starts here.`;
    expect(stripDiscernedSnippet(content)).toBe('Real body starts here.');
  });

  it('is a no-op when no sentinel is present (legacy casts)', () => {
    const content = 'Discerned: General\n\nA Title\nhttps://example.com';
    expect(stripDiscernedSnippet(content)).toBe(content);
  });

  it('does not leak the visible snippet text', () => {
    const content = `${snippet('Discerned by nostr:npub1xyz — Philosophy')}\n\n# Heading`;
    const out = stripDiscernedSnippet(content);
    expect(out).not.toContain('Discerned by');
    expect(out).not.toContain(SNIPPET_SENTINEL_OPEN);
    expect(out).toBe('# Heading');
  });
});

describe('parseEvent — kind 30023 long-form', () => {
  const clipId = 'clip-uuid-1234';
  const body = '# The Article\n\nParagraph one.\n\nParagraph two with a [link](https://example.com).';

  function longFormEvent() {
    return finalizeEvent({
      kind: 30023,
      created_at: 1_700_000_500,
      tags: [
        ['r', 'https://example.com/article'],
        ['L', 'online.discerned.category'],
        ['l', 'Philosophy', 'online.discerned.category'],
        ['L', 'online.discerned.signal'],
        ['l', 'Worthwhile', 'online.discerned.signal'],
        ['t', 'discerned'],
        ['format', 'article'],
        ['client', 'discerned'],
        ['d', clipId],
        ['title', 'The Article'],
        ['summary', 'A concise gloss.'],
        ['published_at', '1699999999'],
        ['image', 'https://cdn.example.com/hero.jpg'],
        ['imeta', 'url https://cdn.example.com/photo.jpg'],
      ],
      content: `${snippet('Discerned by nostr:npub — Philosophy · Worthwhile')}\n\n${body}`,
    }, SK);
  }

  it('sets markdown (snippet-stripped), title, summary, longFormId and axes', () => {
    const clip = parseEvent(longFormEvent());
    expect(clip.capture.kind).toBe(30023);
    expect(clip.capture.markdown).toBe(body);
    expect(clip.capture.markdown).not.toContain('Discerned by');
    expect(clip.capture.title).toBe('The Article');
    expect(clip.capture.summary).toBe('A concise gloss.');
    expect(clip.capture.longFormId).toBe(clipId);
    expect(clip.evaluation.signal).toBe('Worthwhile');
    expect(clip.evaluation.category).toBe('Philosophy');
    expect(clip.capture.imageUrls).toEqual(['https://cdn.example.com/photo.jpg']);
  });

  it('uses published_at (seconds) as the timestamp', () => {
    const clip = parseEvent(longFormEvent());
    expect(clip.capture.timestamp).toBe(1699999999 * 1000);
  });

  it('falls back to created_at when published_at is absent', () => {
    const ev = finalizeEvent({
      kind: 30023,
      created_at: 1_700_000_500,
      tags: [['d', clipId], ['title', 'X'], ['r', 'https://e.com']],
      content: 'body',
    }, SK);
    expect(parseEvent(ev).capture.timestamp).toBe(1_700_000_500 * 1000);
  });
});

describe('parseEvent — kind 1 note references its long-form via longFormId', () => {
  it('extracts the d id from the a tag so the pair can dedup', () => {
    const clipId = 'clip-uuid-9999';
    const ev = finalizeEvent({
      kind: 1,
      created_at: 1_700_000_600,
      tags: [
        ['r', 'https://example.com/article'],
        ['format', 'article'],
        ['title', 'The Article'],
        ['a', `30023:${PK}:${clipId}`, 'wss://relay.example.com'],
      ],
      content: `${snippet('Discerned by nostr:npub — Tech')}\n\nDiscerned: Tech\n\nThe Article\nhttps://example.com/article\n\nRead the full article → nostr:naddr1abc`,
    }, SK);

    const clip = parseEvent(ev);
    expect(clip.capture.kind).toBe(1);
    expect(clip.capture.longFormId).toBe(clipId);
    expect(clip.capture.authorPubkey).toBe(PK);
    // Snippet stripped; title still resolves from the title tag.
    expect(clip.capture.title).toBe('The Article');
  });
});
