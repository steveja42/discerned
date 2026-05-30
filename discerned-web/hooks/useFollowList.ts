// Subscribes to the signed-in user's Nostr follow list (NIP-02 kind:3) and the
// followed accounts' profile metadata (kind:0). Returns an empty list for guests.
// The follows module is dynamically imported so it never runs server-side.

'use client';

import { useState, useEffect } from 'react';
import type { FollowProfile } from '@/lib/nostr/follows';

export function useFollowList(pubkey: string | null) {
  const [follows, setFollows] = useState<FollowProfile[]>([]);

  useEffect(() => {
    setFollows([]);
    if (!pubkey) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { subscribeFollowList } = await import('@/lib/nostr/follows');
        if (cancelled) return;
        cleanup = subscribeFollowList(pubkey, (next) => {
          if (!cancelled) setFollows(next);
        });
      } catch {
        if (!cancelled) setFollows([]);
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [pubkey]);

  return follows;
}
