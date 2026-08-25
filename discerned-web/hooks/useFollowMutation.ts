// Follow/unfollow for the signed-in user's NIP-02 kind:3 contact list. Derives
// membership from the existing useFollowList(myPubkey) subscription (no second
// subscription), and mutates by asking the extension to fetch-mutate-sign-publish
// the real kind:3 event — see extension-bridge.ts's sendFollowPubkeyToExtension.
// The web app has no reliable signer for most auth modes (bridge/readonly can't
// sign at all here), so every auth mode routes through the extension uniformly.
//
// Optimistic: toggling flips local state immediately for menu feedback, then is
// reconciled (kept or reverted) when DISCERNED_BRIDGE_FOLLOW_RESULT arrives. The
// live subscribeFollowList subscription will also eventually reflect the change
// once the relay propagates it — the optimistic set is just a short-lived cover
// for that round-trip.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FollowProfile } from '@/lib/nostr/follows';
import { subscribeBridge, sendFollowPubkeyToExtension, sendUnfollowPubkeyToExtension } from '@/lib/bridge/extension-bridge';

export interface FollowMutationError {
  pubkey: string;
  message: string;
}

export function useFollowMutation(follows: FollowProfile[], extensionPresent: boolean) {
  const baseFollowing = useMemo(() => new Set(follows.map((f) => f.pubkey)), [follows]);
  // Overrides the base set only for pubkeys with an in-flight or just-resolved
  // optimistic toggle; cleared once the base set itself agrees (real update
  // arrived via the live follow-list subscription).
  const [optimistic, setOptimistic] = useState<Map<string, boolean>>(new Map());
  const [lastError, setLastError] = useState<FollowMutationError | null>(null);

  useEffect(() => {
    setOptimistic((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [pubkey, following] of prev) {
        if (baseFollowing.has(pubkey) === following) {
          next.delete(pubkey);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [baseFollowing]);

  useEffect(() => {
    return subscribeBridge((msg) => {
      if (msg.type !== 'DISCERNED_BRIDGE_FOLLOW_RESULT') return;
      if (msg.ok) return; // base set will catch up once the relay propagates
      setOptimistic((prev) => {
        if (!prev.has(msg.pubkey)) return prev;
        const next = new Map(prev);
        next.delete(msg.pubkey);
        return next;
      });
      setLastError({ pubkey: msg.pubkey, message: msg.error ?? 'Follow update failed' });
    });
  }, []);

  const isFollowing = useCallback(
    (pubkey: string) => optimistic.get(pubkey) ?? baseFollowing.has(pubkey),
    [optimistic, baseFollowing],
  );

  const toggleFollow = useCallback(
    (pubkey: string) => {
      if (!extensionPresent) return;
      const nowFollowing = !isFollowing(pubkey);
      setOptimistic((prev) => new Map(prev).set(pubkey, nowFollowing));
      setLastError(null);
      if (nowFollowing) {
        sendFollowPubkeyToExtension(pubkey);
      } else {
        sendUnfollowPubkeyToExtension(pubkey);
      }
    },
    [extensionPresent, isFollowing],
  );

  return { isFollowing, toggleFollow, lastError };
}
