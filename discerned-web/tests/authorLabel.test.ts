// authorLabel chooses how a cast's caster is shown: a *verified* nip05 if present,
// otherwise a slice of the npub (never raw hex). Guards the feed/detail display logic.

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { authorLabel } from '@/lib/nostr/profiles';

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
