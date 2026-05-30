// Manages the live Nostr Cast feed subscription.
// Starts with an empty list and prepends incoming events, deduplicated and
// capped at 200. Feed and parse modules are dynamically imported so they
// never run server-side.

'use client';

import { useState, useEffect } from 'react';
import type { ClipData } from '@/lib/types';

type FeedStatus = 'connecting' | 'live' | 'error';

export function useCastFeed() {
  const [clips, setClips] = useState<ClipData[]>([]);
  const [status, setStatus] = useState<FeedStatus>('connecting');

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
            setClips((prev) => {
              if (prev.some((c) => c.capture.id === clip.capture.id)) return prev;
              // Sort by timestamp descending so newest is always on top,
              // regardless of the order in which relays deliver events.
              return [clip, ...prev]
                .sort((a, b) => b.capture.timestamp - a.capture.timestamp)
                .slice(0, 200);
            });
          },
          () => { if (!cancelled) setStatus('live'); },
        );
      } catch {
        if (!cancelled) setStatus('error');
      }
    };

    setStatus('connecting');
    init();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return { clips, status };
}
