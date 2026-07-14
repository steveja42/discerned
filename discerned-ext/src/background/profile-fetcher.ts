// Role: Background Service Worker — kind-0 profile fetcher
// Description: Fetches the signed-in identity's kind-0 profile metadata (name / nip05)
//              from the ACTIVE_RELAYS set, verifies any nip05 against the domain's
//              /.well-known/nostr.json (NIP-05), and caches the result in
//              chrome.storage.local with a 24h TTL. Used by the overlay settings +
//              footer to display a human-readable identity instead of a bare npub.
//              Mirrors the web app's lib/nostr/profiles.ts parsing (kept in sync manually).
// Access: WebSocket via nostr-tools/pool, global fetch (NIP-05), chrome.storage.local.

import { SimplePool } from 'nostr-tools/pool';
import { isNip05, isValid, type Nip05 } from 'nostr-tools/nip05';
import { STORAGE_KEYS, resolveRelayMode, relaysForMode, type OwnProfile } from '@/shared/types';
import { LL, log } from '@/shared/logger';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

// Mirror of discerned-web/lib/nostr/profiles.ts parseProfileContent: prefer
// display_name over name, extract nip05.
function parseProfileContent(content: string): { name?: string; nip05?: string } {
  try {
    const meta = JSON.parse(content) as { name?: string; display_name?: string; nip05?: string };
    return { name: meta.display_name || meta.name, nip05: meta.nip05 };
  } catch {
    return {};
  }
}

async function readCache(pubkey: string): Promise<OwnProfile | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROFILE_CACHE);
  const cache = (stored[STORAGE_KEYS.PROFILE_CACHE] as Record<string, OwnProfile> | undefined) ?? {};
  const entry = cache[pubkey];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry;
}

async function writeCache(profile: OwnProfile): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROFILE_CACHE);
  const cache = (stored[STORAGE_KEYS.PROFILE_CACHE] as Record<string, OwnProfile> | undefined) ?? {};
  cache[profile.pubkey] = profile;
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE_CACHE]: cache });
}

async function activeRelays(): Promise<string[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RELAYS);
  const mode = resolveRelayMode(stored[STORAGE_KEYS.RELAYS] as string | undefined);
  return relaysForMode(mode);
}

/**
 * Fetch (or serve from cache) the kind-0 profile for `pubkey`. Returns null when
 * no profile is found on the active relays. A fresh cache entry (< 24h) is
 * served without touching the network. On a network fetch, the nip05 (if any)
 * is verified before the result is cached.
 */
export async function fetchOwnProfile(pubkey: string): Promise<OwnProfile | null> {
  const cached = await readCache(pubkey);
  if (cached) {
    log(LL.DEBUG, '[profile] cache hit for', pubkey.slice(0, 8));
    return cached;
  }

  const relays = await activeRelays();
  const pool = new SimplePool();
  let event: { content: string } | null = null;
  try {
    event = await Promise.race([
      pool.get(relays, { kinds: [0], authors: [pubkey] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    log(LL.WARN, '[profile] fetch failed:', err instanceof Error ? err.message : String(err));
  } finally {
    try { pool.close(relays); } catch { /* pool teardown best-effort */ }
  }

  if (!event) {
    log(LL.NORMAL, '[profile] no kind-0 found for', pubkey.slice(0, 8));
    return null;
  }

  const meta = parseProfileContent(event.content);
  let verified = false;
  if (meta.nip05 && isNip05(meta.nip05)) {
    try {
      verified = await isValid(pubkey, meta.nip05 as Nip05);
    } catch {
      verified = false;
    }
  }

  const profile: OwnProfile = {
    pubkey,
    name: meta.name,
    nip05: meta.nip05,
    verified,
    fetchedAt: Date.now(),
  };
  await writeCache(profile);
  log(LL.NORMAL, '[profile] fetched', pubkey.slice(0, 8), meta.nip05 ?? meta.name ?? '(no name)', verified ? '✓' : '');
  return profile;
}
