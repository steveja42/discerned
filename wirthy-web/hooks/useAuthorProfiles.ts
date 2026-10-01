// Subscribes to Nostr kind:0 profile metadata for the distinct authors currently in
// the feed and returns a pubkey -> AuthorProfile map. Re-subscribes only when the set
// of distinct authors changes (not on every clip append). The profiles module is
// dynamically imported so it never runs server-side.

'use client';

import { useState, useEffect, useMemo } from 'react';
import type { ClipData } from '@/lib/types';
import type { AuthorProfile } from '@/lib/nostr/profiles';

const EMPTY: Map<string, AuthorProfile> = new Map();

export function useAuthorProfiles(clips: ClipData[]): Map<string, AuthorProfile> {
  // Stable key over the distinct author set so the effect only re-runs when the
  // membership changes, not when clips are merely re-ordered or appended.
  const authorKey = useMemo(() => {
    const set = new Set<string>();
    for (const c of clips) if (c.capture.authorPubkey) set.add(c.capture.authorPubkey);
    return [...set].sort().join(',');
  }, [clips]);

  // Tagged with the author set it was fetched for, so a membership change reads
  // as empty during render instead of via a setState at the top of the effect.
  const [entry, setEntry] = useState<{ key: string; profiles: Map<string, AuthorProfile> } | null>(null);
  const profiles = authorKey && entry?.key === authorKey ? entry.profiles : EMPTY;

  useEffect(() => {
    if (!authorKey) return;
    const pubkeys = authorKey.split(',');

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { subscribeAuthorProfiles } = await import('@/lib/nostr/profiles');
        if (cancelled) return;
        cleanup = subscribeAuthorProfiles(pubkeys, (next) => {
          if (!cancelled) setEntry({ key: authorKey, profiles: next });
        });
      } catch {
        if (!cancelled) setEntry({ key: authorKey, profiles: EMPTY });
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [authorKey]);

  return profiles;
}
