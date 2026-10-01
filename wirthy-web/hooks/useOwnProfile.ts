// Subscribes to the Nostr kind:0 profile (name / verified nip05) for the
// signed-in user's OWN pubkey and returns it, or null. Mirrors useAuthorProfiles
// (dynamic import so it never runs server-side) but for a single pubkey. A
// module-level session cache means a remount / navigation renders the last-known
// profile instantly instead of flashing the npub fallback while relays reconnect.

'use client';

import { useState, useEffect } from 'react';
import type { AuthorProfile } from '@/lib/nostr/profiles';

const cache = new Map<string, AuthorProfile>();

export function useOwnProfile(pubkey: string | null): AuthorProfile | null {
  // Keyed by the pubkey the value belongs to, so a pubkey change is resolved
  // during render (fall back to that pubkey's cache entry) instead of being
  // reset by a setState at the top of the effect below.
  const [entry, setEntry] = useState<{ pubkey: string; profile: AuthorProfile } | null>(null);

  const profile = pubkey
    ? (entry?.pubkey === pubkey ? entry.profile : cache.get(pubkey) ?? null)
    : null;

  useEffect(() => {
    if (!pubkey) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { subscribeAuthorProfiles } = await import('@/lib/nostr/profiles');
        if (cancelled) return;
        cleanup = subscribeAuthorProfiles([pubkey], (next) => {
          if (cancelled) return;
          const p = next.get(pubkey);
          if (p) {
            cache.set(pubkey, p);
            setEntry({ pubkey, profile: p });
          }
        });
      } catch {
        /* keep whatever the cache gave us */
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [pubkey]);

  return profile;
}
