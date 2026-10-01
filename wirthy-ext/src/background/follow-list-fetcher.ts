// Role: Background Service Worker — NIP-02 follow-list fetcher
// Description: Fetches the signed-in identity's CURRENT kind-3 contact list immediately
//              before a follow/unfollow mutation. Deliberately UNCACHED (unlike
//              relay-list-fetcher.ts's 24h TTL) — kind:3 is fully-replaceable, so
//              publishing from anything but the live tag set risks silently erasing
//              the user's real contacts. A fetch failure returns null (distinct from
//              "no list yet", which is a legitimate {tags:[],content:''}) so the
//              caller can abort the whole mutation instead of publishing from nothing.
// Access: WebSocket via nostr-tools/pool.

import { SimplePool } from 'nostr-tools/pool';
import { getEffectiveRelays } from '@/shared/relays';
import { LL, log } from '@/shared/logger';

const FETCH_TIMEOUT_MS = 5000;

export interface CurrentFollowList {
  tags: string[][];
  content: string;
}

/**
 * Fetch `pubkey`'s current kind-3 contact list, fresh, no cache. Returns
 * `{tags:[],content:''}` when they have no kind-3 yet (first follow ever), or
 * `null` when the fetch failed/timed out — callers MUST treat `null` as "abort",
 * never as license to publish from a reconstructed-from-nothing list.
 */
export async function fetchCurrentFollowList(pubkey: string): Promise<CurrentFollowList | null> {
  const relays = await getEffectiveRelays();
  const pool = new SimplePool();
  try {
    const event = await Promise.race([
      pool.get(relays, { kinds: [3], authors: [pubkey] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);
    if (!event) {
      log(LL.NORMAL, '[follows] no kind-3 found for', pubkey.slice(0, 8));
      return { tags: [], content: '' };
    }
    return { tags: event.tags ?? [], content: event.content ?? '' };
  } catch (err) {
    log(LL.WARN, '[follows] kind-3 fetch failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    try { pool.close(relays); } catch { /* pool teardown best-effort */ }
  }
}
