// authorLabel chooses how a cast's caster is shown: a *verified* nip05 if present,
// otherwise a slice of the npub (never raw hex). Guards the feed/detail display logic.
// authorDisplayName is the looser sibling used by the Publishers filter list, which
// also accepts an unverified kind-0 display name.

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { authorLabel, authorDisplayName } from '@/lib/nostr/profiles';

const pubkey = getPublicKey(generateSecretKey());

describe('authorLabel', () => {
  it('shows a verified nip05 verbatim', () => {
    expect(authorLabel(pubkey, { pubkey, nip05: 'alice@example.com', verified: true }))
      .toBe('alice@example.com');
  });

  it('falls back to an npub slice when nip05 is unverified', () => {
    const expected = `${npubEncode(pubkey).slice(0, 12)}…`;
    expect(authorLabel(pubkey, { pubkey, nip05: 'alice@example.com', verified: false }))
      .toBe(expected);
    expect(authorLabel(pubkey, { pubkey, nip05: 'alice@example.com' }))
      .toBe(expected);
  });

  it('falls back to an npub slice with no profile at all', () => {
    expect(authorLabel(pubkey)).toBe(`${npubEncode(pubkey).slice(0, 12)}…`);
  });

  it('never leaks raw hex for a verified profile that has no nip05', () => {
    const label = authorLabel(pubkey, { pubkey, name: 'Alice', verified: true });
    expect(label).toBe(`${npubEncode(pubkey).slice(0, 12)}…`);
    expect(label).not.toBe(pubkey);
  });
});

describe('authorDisplayName', () => {
  const npubSlice = `${npubEncode(pubkey).slice(0, 12)}…`;

  it('prefers a verified nip05 over the display name', () => {
    expect(authorDisplayName(pubkey, { pubkey, name: 'Alice', nip05: 'alice@example.com', verified: true }))
      .toBe('alice@example.com');
  });

  it('uses the kind-0 display name when the nip05 is unverified', () => {
    expect(authorDisplayName(pubkey, { pubkey, name: 'Alice', nip05: 'alice@example.com' }))
      .toBe('Alice');
  });

  it('uses the kind-0 display name when there is no nip05 at all', () => {
    expect(authorDisplayName(pubkey, { pubkey, name: 'Alice' })).toBe('Alice');
  });

  it('ignores a blank or whitespace-only name', () => {
    expect(authorDisplayName(pubkey, { pubkey, name: '   ' })).toBe(npubSlice);
    expect(authorDisplayName(pubkey, { pubkey, name: '' })).toBe(npubSlice);
  });

  it('trims surrounding whitespace from the name', () => {
    expect(authorDisplayName(pubkey, { pubkey, name: '  Alice  ' })).toBe('Alice');
  });

  it('falls back to an npub slice with no profile at all, never raw hex', () => {
    const label = authorDisplayName(pubkey);
    expect(label).toBe(npubSlice);
    expect(label).not.toBe(pubkey);
  });
});
