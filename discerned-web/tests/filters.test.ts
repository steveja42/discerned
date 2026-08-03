// The new rating-system filter predicates that drive both the /discerns feed
// and the /clips library sidebar. These are the derivation functions behind
// the Signal pips + Qualifier chips — a regression here silently empties (or
// fails to narrow) the feed.

import { describe, it, expect } from 'vitest';
import {
  matchesSignal,
  matchesQualifiers,
  matchesAuthors,
  deriveQualifierOptions,
  signalRank,
  BUILTIN_QUALIFIERS,
  SIGNAL_LEVELS,
} from '@/lib/constants';
import type { ClipData } from '@/lib/types';

function clipWithQuals(qualifiers: string[]): ClipData {
  return {
    capture: {
      id: `c-${qualifiers.join('-') || 'none'}`,
      format: 'article',
      url: 'https://example.com',
      title: 'T',
      timestamp: 1,
    },
    evaluation: { qualifiers, category: 'General' },
    encrypted: '',
  };
}

describe('matchesSignal', () => {
  it('passes everything when no signal is selected', () => {
    expect(matchesSignal('Worthwhile', [])).toBe(true);
    expect(matchesSignal(undefined, [])).toBe(true);
  });

  it('matches only the exact selected levels (OR across selection)', () => {
    expect(matchesSignal('Worthwhile', ['Worthwhile'])).toBe(true);
    expect(matchesSignal('Worthwhile', ['Toxic', 'Worthwhile'])).toBe(true);
    expect(matchesSignal('Masterpiece', ['Worthwhile'])).toBe(false);
    // Exact-level semantics: selecting a level is NOT a minimum threshold.
    expect(matchesSignal('Masterpiece', ['Ordinary'])).toBe(false);
  });

  it('excludes unrated clips once any level is selected', () => {
    expect(matchesSignal(undefined, ['Worthwhile'])).toBe(false);
  });
});

describe('matchesQualifiers', () => {
  it('passes everything when no qualifier is selected', () => {
    expect(matchesQualifiers(['Timeless'], [])).toBe(true);
    expect(matchesQualifiers(undefined, [])).toBe(true);
  });

  it('OR-matches: one shared qualifier suffices', () => {
    expect(matchesQualifiers(['Timeless', 'Quick Read'], ['Quick Read', 'Primary Source'])).toBe(true);
    expect(matchesQualifiers(['Timeless'], ['Primary Source'])).toBe(false);
  });

  it('clips without qualifiers fail any active qualifier filter', () => {
    expect(matchesQualifiers([], ['Timeless'])).toBe(false);
    expect(matchesQualifiers(undefined, ['Timeless'])).toBe(false);
  });
});

describe('matchesAuthors', () => {
  const alice = 'a'.repeat(64);
  const bob = 'b'.repeat(64);
  const carol = 'c'.repeat(64);

  it('passes everything when no author is selected', () => {
    expect(matchesAuthors(alice, [])).toBe(true);
    expect(matchesAuthors(undefined, [])).toBe(true);
  });

  it('OR-matches across a multi-author selection', () => {
    expect(matchesAuthors(alice, [alice, bob])).toBe(true);
    expect(matchesAuthors(bob, [alice, bob])).toBe(true);
    expect(matchesAuthors(carol, [alice, bob])).toBe(false);
  });

  it('excludes clips with no author once any author is selected', () => {
    expect(matchesAuthors(undefined, [alice])).toBe(false);
  });
});

describe('deriveQualifierOptions', () => {
  it('returns just the built-ins for clips with no custom qualifiers', () => {
    const clips = [clipWithQuals(['Timeless']), clipWithQuals([])];
    expect(deriveQualifierOptions(clips)).toEqual([...BUILTIN_QUALIFIERS]);
  });

  it('appends custom qualifiers sorted after the built-ins, deduped', () => {
    const clips = [
      clipWithQuals(['Stoicism', 'Timeless']),
      clipWithQuals(['Bitcoin', 'Stoicism']),
    ];
    expect(deriveQualifierOptions(clips)).toEqual([...BUILTIN_QUALIFIERS, 'Bitcoin', 'Stoicism']);
  });

  it('never duplicates a built-in that appears on a clip', () => {
    const opts = deriveQualifierOptions([clipWithQuals(['Quick Read'])]);
    expect(opts.filter((q) => q === 'Quick Read')).toHaveLength(1);
  });
});

describe('signalRank', () => {
  it('maps levels to 1–5 stars in vocabulary order', () => {
    SIGNAL_LEVELS.forEach((lvl, i) => expect(signalRank(lvl)).toBe(i + 1));
  });

  it('returns 0 for unrated or unknown levels', () => {
    expect(signalRank(undefined)).toBe(0);
    expect(signalRank('Stupendous')).toBe(0);
  });
});
