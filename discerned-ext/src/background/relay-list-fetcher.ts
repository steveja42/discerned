// Role: Background Service Worker — NIP-65 relay-list fetcher
// Description: Fetches the signed-in identity's kind-10002 relay list (NIP-65) and returns the
//              relays they declare they WRITE to, so discerned publishes where that user's
//              audience actually reads. Cached per-pubkey in chrome.storage.local with a 24h TTL.
//              Works for every auth mode (nip07 / nip46 / nsec) because it needs only a pubkey.
//              Mirrors profile-fetcher.ts's pool/timeout/cache shape.
// Access: WebSocket via nostr-tools/pool, chrome.storage.local.

import { SimplePool } from 'nostr-tools/pool';
import { STORAGE_KEYS } from '@/shared/types';
import { getEffectiveRelays, normaliseRelayList } from '@/shared/relays';
import { LL, log } from '@/shared/logger';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

// Cap on how many write relays we adopt from one list. A pathological kind-10002
// with dozens of entries would otherwise open a socket per relay on every publish.
const MAX_ADOPTED_RELAYS = 10;

interface DiscoveryEntry {
  relays: string[];
  fetchedAt: number;
}

type DiscoveryCache = Record<string, DiscoveryEntry>;

async function readCache(pubkey: string): Promise<DiscoveryEntry | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RELAY_DISCOVERY);
  const cache = (stored[STORAGE_KEYS.RELAY_DISCOVERY] as DiscoveryCache | undefined) ?? {};
  const entry = cache[pubkey];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry;
}

async function writeCache(pubkey: string, relays: string[]): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RELAY_DISCOVERY);
  const cache = (stored[STORAGE_KEYS.RELAY_DISCOVERY] as DiscoveryCache | undefined) ?? {};
  cache[pubkey] = { relays, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.RELAY_DISCOVERY]: cache });
}

/** Forget one identity's cached discovery (called on disconnect). */
export async function clearDiscoveryCache(pubkey: string): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RELAY_DISCOVERY);
  const cache = (stored[STORAGE_KEYS.RELAY_DISCOVERY] as DiscoveryCache | undefined) ?? {};
  if (!(pubkey in cache)) return;
  delete cache[pubkey];
  await chrome.storage.local.set({ [STORAGE_KEYS.RELAY_DISCOVERY]: cache });
}

/**
 * Extract the WRITE relays from a kind-10002 event's tags.
 *
 * NIP-65: each entry is `["r", "<url>", "<marker>?"]` where the optional marker
 * is "read" or "write". No marker means the relay is used for BOTH, so it
 * counts as a write relay. A "read"-only relay is where the user reads other
 * people's notes — publishing there would not reach their audience.
 */
export function parseWriteRelays(tags: string[][]): string[] {
  const urls: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
    const marker = tag[2];
    if (marker === 'read') continue;
    urls.push(tag[1]);
  }
  return normaliseRelayList(urls).slice(0, MAX_ADOPTED_RELAYS);
}

/**
 * Fetch (or serve from cache) the write relays `pubkey` declares in their NIP-65
 * relay list. Returns [] when they have no kind-10002, the fetch times out, or
 * the event is malformed. Never throws — relay discovery is best-effort and must
 * never break sign-in.
 */
export async function fetchPreferredRelays(pubkey: string): Promise<string[]> {
  const cached = await readCache(pubkey);
  if (cached) {
    log(LL.DEBUG, '[relays] discovery cache hit for', pubkey.slice(0, 8), `(${cached.relays.length})`);
    return cached.relays;
  }

  const relays = await getEffectiveRelays();
  const pool = new SimplePool();
  let event: { tags: string[][] } | null = null;
  try {
    event = await Promise.race([
      pool.get(relays, { kinds: [10002], authors: [pubkey] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    log(LL.WARN, '[relays] kind-10002 fetch failed:', err instanceof Error ? err.message : String(err));
  } finally {
    try { pool.close(relays); } catch { /* pool teardown best-effort */ }
  }

  if (!event) {
    // Cache the miss too, so an identity with no relay list isn't re-fetched on
    // every single sign-in.
    await writeCache(pubkey, []);
    log(LL.NORMAL, '[relays] no kind-10002 found for', pubkey.slice(0, 8));
    return [];
  }

  let writeRelays: string[] = [];
  try {
    writeRelays = parseWriteRelays(event.tags ?? []);
  } catch {
    writeRelays = [];
  }

  await writeCache(pubkey, writeRelays);
  log(LL.NORMAL, `[relays] kind-10002 for ${pubkey.slice(0, 8)}: ${writeRelays.length} write relay(s)`);
  return writeRelays;
}
