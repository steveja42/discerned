// Role: Background — NIP-05 names map fetcher / cache
// Description: Pulls https://discerned.online/.well-known/nostr.json on a schedule,
//              caches it in chrome.storage.local, and exposes a diff helper so the
//              background can republish kind 0 when the current user's local-part
//              changes. Source of truth is the JSON in the web app's repo.
// Access: fetch (host_permissions: <all_urls>), chrome.storage.local

import { STORAGE_KEYS } from '@/shared/types';
import { LL, log } from '@/shared/logger';

const PROD_URL = 'https://discerned.online/.well-known/nostr.json';
const DEV_URL = 'http://localhost:3000/.well-known/nostr.json';
const FETCH_TIMEOUT_MS = 5000;

export interface Nip05Profile {
  about?: string;
  picture?: string;
}

export interface CachedNip05 {
  fetchedAt: number;
  names: Record<string, string>;   // local-part -> hex pubkey
  relays?: Record<string, string[]>;
  // Non-standard extension to NIP-05: per-pubkey kind-0 fields the extension
  // copies into the published profile. Spec verifiers ignore unknown keys.
  profiles?: Record<string, Nip05Profile>;   // hex pubkey -> { about, picture }
}

export interface RefreshResult {
  cache: CachedNip05 | null;
  changedForMe: boolean;
  oldLocal: string | null;
  newLocal: string | null;
}

/**
 * Reverse-lookup: given a hex pubkey, return its local-part if mapped, else null.
 * Used both inside this module (diff) and by background callers building the
 * kind-0 ProfileMetadata.
 */
export function localPartFor(cache: CachedNip05 | null, pubkeyHex: string | null): string | null {
  if (!cache || !pubkeyHex) return null;
  for (const [local, hex] of Object.entries(cache.names)) {
    if (hex.toLowerCase() === pubkeyHex.toLowerCase()) return local;
  }
  return null;
}

/**
 * Per-pubkey `about` / `picture` extras from the map, if present. Used to fill
 * the kind-0 profile beyond the NIP-05 verification fields.
 */
export function profileFor(cache: CachedNip05 | null, pubkeyHex: string | null): Nip05Profile {
  if (!cache?.profiles || !pubkeyHex) return {};
  return cache.profiles[pubkeyHex.toLowerCase()] ?? {};
}

export async function getCachedNip05(): Promise<CachedNip05 | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.NIP05_CACHE);
  const v = stored[STORAGE_KEYS.NIP05_CACHE];
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<CachedNip05>;
  if (typeof c.fetchedAt !== 'number' || !c.names || typeof c.names !== 'object') return null;
  return c as CachedNip05;
}

async function fetchOnce(url: string): Promise<CachedNip05 | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!res.ok) {
      log(LL.WARN, '[nip05] fetch returned non-OK', res.status, 'url:', url);
      return null;
    }
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object') return null;
    const obj = json as { names?: unknown; relays?: unknown; profiles?: unknown };
    if (!obj.names || typeof obj.names !== 'object') return null;
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.names as Record<string, unknown>)) {
      if (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) names[k] = v.toLowerCase();
    }
    const relays: Record<string, string[]> | undefined =
      obj.relays && typeof obj.relays === 'object'
        ? Object.fromEntries(
            Object.entries(obj.relays as Record<string, unknown>)
              .filter(([, v]) => Array.isArray(v) && (v as unknown[]).every(s => typeof s === 'string'))
              .map(([k, v]) => [k.toLowerCase(), v as string[]]),
          )
        : undefined;
    const profiles: Record<string, Nip05Profile> | undefined =
      obj.profiles && typeof obj.profiles === 'object'
        ? Object.fromEntries(
            Object.entries(obj.profiles as Record<string, unknown>)
              .filter(([, v]) => v && typeof v === 'object')
              .map(([k, v]) => {
                const p = v as { about?: unknown; picture?: unknown };
                const entry: Nip05Profile = {};
                if (typeof p.about === 'string') entry.about = p.about;
                if (typeof p.picture === 'string') entry.picture = p.picture;
                return [k.toLowerCase(), entry];
              }),
          )
        : undefined;
    return { fetchedAt: Date.now(), names, relays, profiles };
  } catch (err) {
    log(LL.WARN, '[nip05] fetch failed', err, 'url:', url);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the names map, write it to storage, and report whether the user's local-part
 * changed. On network failure the previous cache is preserved and `cache` in the
 * result will be the previous value (or null if there wasn't one).
 *
 * Tries production first; in dev (localhost open) the production URL may not yet
 * have the map you're testing — caller can pass `preferDev: true` to flip the order.
 */
export async function refreshNip05Cache(
  myPubkey: string | null,
  preferDev = false,
): Promise<RefreshResult> {
  const previous = await getCachedNip05();
  const oldLocal = localPartFor(previous, myPubkey);

  const urls = preferDev ? [DEV_URL, PROD_URL] : [PROD_URL, DEV_URL];
  let fresh: CachedNip05 | null = null;
  for (const url of urls) {
    fresh = await fetchOnce(url);
    if (fresh) break;
  }

  if (!fresh) {
    return { cache: previous, changedForMe: false, oldLocal, newLocal: oldLocal };
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.NIP05_CACHE]: fresh });
  const newLocal = localPartFor(fresh, myPubkey);
  return {
    cache: fresh,
    changedForMe: oldLocal !== newLocal,
    oldLocal,
    newLocal,
  };
}
