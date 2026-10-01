// The companion kind-1 note and kind-30023 long-form must collapse to one feed
// row, preferring the richer long-form.

import { describe, it, expect } from 'vitest';
import { dedupKey, preferLongForm } from '@/hooks/useCastFeed';
import type { ClipData } from '@/lib/types';

const PK = 'a'.repeat(64);
const CLIP_ID = 'clip-uuid-1';

function make(kind: 1 | 30023, overrides: Partial<ClipData['capture']> = {}): ClipData {
  return {
    capture: {
      id: kind === 30023 ? 'evt-longform' : 'evt-note',
      kind,
      format: 'article',
      url: 'https://example.com/a',
      title: 'The Article',
      timestamp: 1_700_000_000_000,
      authorPubkey: PK,
      longFormId: CLIP_ID,
      ...overrides,
    },
    evaluation: { category: 'Tech', qualifiers: [] },
    encrypted: '',
  };
}

describe('feed dedup key', () => {
  it('the note and its long-form share a key (author + longFormId)', () => {
    expect(dedupKey(make(1))).toBe(dedupKey(make(30023)));
    expect(dedupKey(make(1))).toBe(`${PK}:${CLIP_ID}`);
  });

  it('a standalone clip keys on its own event id', () => {
    const standalone = make(1, { longFormId: undefined });
    expect(dedupKey(standalone)).toBe('evt-note');
  });
});

describe('preferLongForm', () => {
  it('prefers the kind-30023 regardless of argument order', () => {
    const note = make(1);
    const long = make(30023);
    expect(preferLongForm(note, long)).toBe(long);
    expect(preferLongForm(long, note)).toBe(long);
  });

  it('keeps the incumbent when both are the same kind', () => {
    const a = make(30023, { id: 'a' });
    const b = make(30023, { id: 'b' });
    expect(preferLongForm(a, b)).toBe(a);
  });
});
