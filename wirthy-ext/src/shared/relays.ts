// Role: Shared — effective relay-set resolution
// Description: Single source of truth for "which relays do we actually use". Resolves the
//              user-owned relay set (mode defaults ∪ the user's own relays − explicit removals)
//              from chrome.storage.local, and normalises relay URLs so the same relay can't
//              appear twice under two spellings. Every relay consumer — publish, profile fetch,
//              nprofile/naddr hints, the overlay's relay count — goes through getEffectiveRelays().
// Access: chrome.storage.local. No DOM, no network — safe in both the SW and content scripts.

import {
  STORAGE_KEYS,
  LOCAL_RELAY,
  DEFAULT_RELAYS,
  resolveRelayMode,
  relaysForMode,
  type RelayRow,
} from '@/shared/types';

/**
 * Normalise a relay URL to a canonical form so `wss://a.com`, `wss://A.com/`
 * and `a.com` all collapse to one entry.
 *
 * Returns null when the input can't be a relay URL — the caller decides whether
 * that's a validation error (the add form) or something to skip (a malformed
 * NIP-65 tag).
 */
export function normaliseRelayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Bare host ("relay.primal.net") → assume wss://, the only scheme we'd suggest.
  // An explicit http:/https: is NOT silently upgraded — that's a user mistake
  // worth reporting rather than quietly reinterpreting.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null;
  if (!url.hostname) return null;

  // Host is case-insensitive; the path is not. Drop a lone trailing slash (the
  // overwhelmingly common shape) but preserve a real path — some relays are
  // served from a subpath.
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

/** Normalise a list, dropping invalid entries and duplicates while keeping order. */
export function normaliseRelayList(raws: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const url = normaliseRelayUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

interface StoredRelayPrefs {
  mode: ReturnType<typeof resolveRelayMode>;
  base: string[];
  user: string[];
  removed: string[];
}

async function readRelayPrefs(): Promise<StoredRelayPrefs> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.RELAYS,
    STORAGE_KEYS.USER_RELAYS,
    STORAGE_KEYS.REMOVED_RELAYS,
  ]);
  const mode = resolveRelayMode(stored[STORAGE_KEYS.RELAYS] as string | undefined);
  return {
    mode,
    base: relaysForMode(mode),
    user: normaliseRelayList((stored[STORAGE_KEYS.USER_RELAYS] as string[] | undefined) ?? []),
    removed: normaliseRelayList((stored[STORAGE_KEYS.REMOVED_RELAYS] as string[] | undefined) ?? []),
  };
}

/**
 * The relay set to publish to and read from, resolved at call time.
 *
 * Effective = (mode defaults ∪ user relays) − removed relays.
 *
 * Two invariants worth knowing:
 *  - LOCAL MODE IS EXCLUSIVE. In 'local' mode the result is exactly
 *    [LOCAL_RELAY]. The whole point of the local relay is that dev/test casts
 *    never touch the real network, so unioning the user's public relays in
 *    would defeat it.
 *  - NEVER EMPTY. If removals would empty the set we fall back to the mode
 *    defaults, so a user can't strand themselves with an unpublishable clip.
 */
export async function getEffectiveRelays(): Promise<string[]> {
  const { mode, base, user, removed } = await readRelayPrefs();
  if (mode === 'local') return [LOCAL_RELAY];

  const removedSet = new Set(removed);
  const merged = [...new Set([...base, ...user])].filter((url) => !removedSet.has(url));
  return merged.length > 0 ? merged : base;
}

/**
 * The same set as getEffectiveRelays(), annotated with where each relay came
 * from so the management UI can badge rows and route a removal to the right
 * storage key. Rows are ordered defaults-first, then the user's own.
 *
 * A relay is 'discovered' when it's in the user list AND was seen in some
 * identity's NIP-65 list; 'user' when the user typed it. Both live in
 * USER_RELAYS — the discovery cache is what distinguishes them.
 */
export async function getRelayRows(): Promise<RelayRow[]> {
  const { mode, base, user, removed } = await readRelayPrefs();
  if (mode === 'local') return [{ url: LOCAL_RELAY, source: 'default' }];

  const removedSet = new Set(removed);
  const discovered = await readDiscoveredUrls();
  const rows: RelayRow[] = [];
  const seen = new Set<string>();

  for (const url of [...base, ...user]) {
    if (seen.has(url) || removedSet.has(url)) continue;
    seen.add(url);
    const isDefault = (DEFAULT_RELAYS as readonly string[]).includes(url);
    rows.push({
      url,
      source: isDefault ? 'default' : discovered.has(url) ? 'discovered' : 'user',
    });
  }
  return rows;
}

/** Every relay URL ever seen in a NIP-65 list, across all cached identities. */
async function readDiscoveredUrls(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RELAY_DISCOVERY);
  const cache =
    (stored[STORAGE_KEYS.RELAY_DISCOVERY] as
      | Record<string, { relays: string[]; fetchedAt: number }>
      | undefined) ?? {};
  const urls = new Set<string>();
  for (const entry of Object.values(cache)) {
    for (const url of entry.relays ?? []) urls.add(url);
  }
  return urls;
}

/**
 * Persist an edited relay list. Both arrays are normalised and de-duplicated,
 * and any URL present in both wins as REMOVED (an explicit removal is the more
 * specific intent).
 */
export async function saveRelayPrefs(userRelays: string[], removedRelays: string[]): Promise<void> {
  const removed = normaliseRelayList(removedRelays);
  const removedSet = new Set(removed);
  const user = normaliseRelayList(userRelays).filter((url) => !removedSet.has(url));
  await chrome.storage.local.set({
    [STORAGE_KEYS.USER_RELAYS]: user,
    [STORAGE_KEYS.REMOVED_RELAYS]: removed,
  });
}

/**
 * Merge freshly discovered relays into the user's list.
 *
 * Anything the user explicitly removed is skipped — re-discovery must never
 * resurrect a relay they chose to drop, or the remove button silently undoes
 * itself at the next sign-in. Returns the URLs actually added.
 */
export async function mergeDiscoveredRelays(discovered: readonly string[]): Promise<string[]> {
  const incoming = normaliseRelayList(discovered);
  if (incoming.length === 0) return [];

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.USER_RELAYS,
    STORAGE_KEYS.REMOVED_RELAYS,
  ]);
  const user = normaliseRelayList((stored[STORAGE_KEYS.USER_RELAYS] as string[] | undefined) ?? []);
  const removed = new Set(
    normaliseRelayList((stored[STORAGE_KEYS.REMOVED_RELAYS] as string[] | undefined) ?? []),
  );
  const existing = new Set([...user, ...(DEFAULT_RELAYS as readonly string[])]);

  const added = incoming.filter((url) => !existing.has(url) && !removed.has(url));
  if (added.length === 0) return [];

  await chrome.storage.local.set({ [STORAGE_KEYS.USER_RELAYS]: [...user, ...added] });
  return added;
}
