// Subscribes to the signed-in user's Nostr follow list (NIP-02 kind:3) and the
// followed accounts' profile metadata (kind:0). Returns an empty list for guests.
// The follows module is dynamically imported so it never runs server-side.

'use client';

import { useState, useEffect } from 'react';
import type { FollowProfile } from '@/lib/nostr/follows';

const EMPTY: FollowProfile[] = [];

export function useFollowList(pubkey: string | null) {
  // Tagged with the pubkey it was fetched for, so switching identity yields an
  // empty list during render rather than needing a setState reset in the effect
  // (which would render the previous user's follows for one frame).
  const [entry, setEntry] = useState<{ pubkey: string; follows: FollowProfile[] } | null>(null);
  const follows = pubkey && entry?.pubkey === pubkey ? entry.follows : EMPTY;

  useEffect(() => {
    if (!pubkey) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { subscribeFollowList } = await import('@/lib/nostr/follows');
        if (cancelled) return;
        cleanup = subscribeFollowList(pubkey, (next) => {
          if (!cancelled) setEntry({ pubkey, follows: next });
        });
      } catch {
        if (!cancelled) setEntry({ pubkey, follows: EMPTY });
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [pubkey]);

  return follows;
}
