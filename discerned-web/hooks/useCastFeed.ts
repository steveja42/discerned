// Manages the live Nostr Cast feed subscription.
// Starts with an empty list and prepends incoming events, deduplicated and
// capped at 200. Feed and parse modules are dynamically imported so they
// never run server-side.

'use client';

import { useState, useEffect } from 'react';
import type { ClipData } from '@/lib/types';

type FeedStatus = 'connecting' | 'live' | 'error';

// A companion kind-1 note (a summary + link) and its kind-30023 long-form share
// this key: author pubkey + the long-form's `d` id. The note exposes it via its
// `a` tag, the long-form via its own `d` tag (both surfaced as capture.longFormId
// by parseEvent). Standalone clips fall back to their own event id.
export function dedupKey(clip: ClipData): string {
  const { longFormId, authorPubkey, id } = clip.capture;
  return longFormId && authorPubkey ? `${authorPubkey}:${longFormId}` : id;
}

// Of two clips sharing a dedup key, prefer the richer kind-30023 long-form.
export function preferLongForm(a: ClipData, b: ClipData): ClipData {
  const aIsLong = a.capture.kind === 30023;
  const bIsLong = b.capture.kind === 30023;
  if (aIsLong && !bIsLong) return a;
  if (bIsLong && !aIsLong) return b;
  return a; // both same kind — keep the incumbent
}

const NO_CLIPS: ClipData[] = [];

export function useCastFeed() {
  // Tagged with the relay epoch the casts came from. A mode flip therefore reads
  // as an empty feed during render, rather than needing a setClips([]) reset at
  // the top of the subscribe effect.
  const [entry, setEntry] = useState<{ epoch: number; clips: ClipData[] }>({ epoch: 0, clips: NO_CLIPS });
  // Status is epoch-scoped for the same reason: re-subscribing against a new
  // relay set is a fresh connection, so it reads back as 'connecting' during
  // render instead of being reset by a setState in the effect.
  const [statusEntry, setStatus] = useState<{ epoch: number; status: FeedStatus }>({ epoch: 0, status: 'connecting' });
  // Bumped whenever the dev relay mode flips, forcing the subscribe effect to
  // tear down its pool and re-subscribe against the new relay set.
  const [relayEpoch, setRelayEpoch] = useState(0);

  useEffect(() => {
    let active = true;
    let cleanupSub: (() => void) | undefined;
    import('@/lib/constants').then(({ onRelayModeChange }) => {
      if (!active) return;
      cleanupSub = onRelayModeChange(() => setRelayEpoch((e) => e + 1));
    });
    return () => { active = false; cleanupSub?.(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const init = async () => {
      try {
        const [{ subscribeFeed }, { parseEvent }] = await Promise.all([
          import('@/lib/nostr/feed'),
          import('@/lib/nostr/parse'),
        ]);
        if (cancelled) return;
        cleanup = subscribeFeed(
          (e) => {
            if (cancelled) return;
            const clip = parseEvent(e);
            setEntry((prevEntry) => {
              // Casts from a superseded relay set are dropped rather than merged:
              // a mode flip starts the feed over from empty.
              const prev = prevEntry.epoch === relayEpoch ? prevEntry.clips : NO_CLIPS;
              // Companion kind-1 note + kind-30023 long-form share a dedup key
              // (author + long-form id); keep only one, PREFERRING the richer
              // 30023. Standalone clips key on their own event id.
              const key = dedupKey(clip);
              const existingIdx = prev.findIndex((c) => dedupKey(c) === key);
              let next: ClipData[];
              if (existingIdx >= 0) {
                const existing = prev[existingIdx];
                // Same event re-delivered, or the less-preferred half of a pair:
                // keep what we have.
                if (preferLongForm(existing, clip) === existing) {
                  return prevEntry.epoch === relayEpoch ? prevEntry : { epoch: relayEpoch, clips: prev };
                }
                next = [...prev];
                next[existingIdx] = clip;
              } else {
                next = [clip, ...prev];
              }
              // Sort by timestamp descending so newest is always on top,
              // regardless of the order in which relays deliver events.
              return {
                epoch: relayEpoch,
                clips: next
                  .sort((a, b) => b.capture.timestamp - a.capture.timestamp)
                  .slice(0, 200),
              };
            });
          },
          () => { if (!cancelled) setStatus({ epoch: relayEpoch, status: 'live' }); },
        );
      } catch {
        if (!cancelled) setStatus({ epoch: relayEpoch, status: 'error' });
      }
    };

    init();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [relayEpoch]);

  const clips = entry.epoch === relayEpoch ? entry.clips : NO_CLIPS;
  const status = statusEntry.epoch === relayEpoch ? statusEntry.status : 'connecting';
  return { clips, status };
}
