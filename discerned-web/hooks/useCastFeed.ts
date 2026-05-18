// Manages the live Nostr Cast feed subscription.
// Pre-seeds the list with MOCK_CLIPS while the relay connection establishes,
// then deduplicates and prepends incoming events up to a cap of 200.
// Feed and parse modules are dynamically imported so they never run server-side.

'use client';

import { useState, useEffect } from 'react';
import type { ClipData } from '@/lib/types';
import { MOCK_CLIPS } from '@/lib/mockData';

type FeedStatus = 'connecting' | 'live' | 'error';

export function useCastFeed() {
  const [clips, setClips] = useState<ClipData[]>(MOCK_CLIPS);
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
              return [clip, ...prev].slice(0, 200);
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
