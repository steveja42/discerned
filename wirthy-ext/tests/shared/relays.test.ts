// Effective relay-set resolution: the union of the mode's defaults with the
// user's own relays, minus anything they explicitly removed. These rules decide
// where every cast is published, so the edge cases matter — a removal that
// silently resurrects, or a "local" mode that leaks to public relays, are both
// user-visible bugs.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORAGE_KEYS, DEFAULT_RELAYS, LOCAL_RELAY } from '@/shared/types';
import {
  normaliseRelayUrl,
  normaliseRelayList,
  getEffectiveRelays,
  getRelayRows,
  saveRelayPrefs,
  mergeDiscoveredRelays,
} from '@/shared/relays';

// A real in-memory backing store so set() is observable by a later get().
// The shared setup.ts shim returns a fixed {} — fine for read-only consumers,
// but these tests round-trip through storage.
let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  const local = chrome.storage.local as unknown as {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  local.get.mockImplementation(async (keys: string | string[]) => {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of wanted) if (k in store) out[k] = store[k];
    return out;
  });
  local.set.mockImplementation(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  // Default to production so tests exercise the union path; the build flag
  // would otherwise resolve to 'local', which is deliberately exclusive.
  store[STORAGE_KEYS.RELAYS] = 'production';
});

describe('normaliseRelayUrl', () => {
  it('defaults a bare host to wss://', () => {
    expect(normaliseRelayUrl('relay.example.com')).toBe('wss://relay.example.com');
  });

  it('drops a lone trailing slash so one relay cannot appear twice', () => {
    expect(normaliseRelayUrl('wss://relay.example.com/')).toBe('wss://relay.example.com');
    expect(normaliseRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
  });

  it('lowercases the host but preserves a real path', () => {
    expect(normaliseRelayUrl('wss://Relay.Example.COM/nostr')).toBe('wss://relay.example.com/nostr');
  });

  it('accepts ws:// (the local dev relay)', () => {
    expect(normaliseRelayUrl('ws://localhost:7777')).toBe('ws://localhost:7777');
  });

  it('rejects non-websocket schemes rather than silently upgrading them', () => {
    expect(normaliseRelayUrl('https://relay.example.com')).toBeNull();
    expect(normaliseRelayUrl('http://relay.example.com')).toBeNull();
  });

  it('rejects empty and unparseable input', () => {
    expect(normaliseRelayUrl('')).toBeNull();
    expect(normaliseRelayUrl('   ')).toBeNull();
    expect(normaliseRelayUrl('wss://')).toBeNull();
  });

  it('de-duplicates a list by canonical form, keeping order', () => {
    expect(normaliseRelayList([
      'wss://a.example.com/',
      'wss://A.example.com',
      'nope://bad',
      'wss://b.example.com',
    ])).toEqual(['wss://a.example.com', 'wss://b.example.com']);
  });
});

describe('getEffectiveRelays', () => {
  it('returns the defaults when the user has no relays of their own', async () => {
    expect(await getEffectiveRelays()).toEqual([...DEFAULT_RELAYS]);
  });

  it('unions the user\'s relays with the defaults', async () => {
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://mine.example.com'];
    expect(await getEffectiveRelays()).toEqual([...DEFAULT_RELAYS, 'wss://mine.example.com']);
  });

  it('removes a built-in default the user dropped', async () => {
    store[STORAGE_KEYS.REMOVED_RELAYS] = ['wss://relay.snort.social'];
    const relays = await getEffectiveRelays();
    expect(relays).not.toContain('wss://relay.snort.social');
    expect(relays).toContain('wss://relay.primal.net');
  });

  it('removes a user relay the user dropped', async () => {
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://mine.example.com'];
    store[STORAGE_KEYS.REMOVED_RELAYS] = ['wss://mine.example.com'];
    expect(await getEffectiveRelays()).toEqual([...DEFAULT_RELAYS]);
  });

  it('never returns empty — removing everything falls back to the defaults', async () => {
    store[STORAGE_KEYS.REMOVED_RELAYS] = [...DEFAULT_RELAYS];
    expect(await getEffectiveRelays()).toEqual([...DEFAULT_RELAYS]);
  });

  it('matches removals through normalisation (trailing slash / case)', async () => {
    store[STORAGE_KEYS.REMOVED_RELAYS] = ['WSS://Relay.Snort.Social/'];
    expect(await getEffectiveRelays()).not.toContain('wss://relay.snort.social');
  });

  it('LOCAL mode is exclusive — the user\'s public relays must not leak in', async () => {
    store[STORAGE_KEYS.RELAYS] = 'local';
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://mine.example.com'];
    expect(await getEffectiveRelays()).toEqual([LOCAL_RELAY]);
  });
});

describe('getRelayRows', () => {
  it('labels built-ins as default and the user\'s own as user', async () => {
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://mine.example.com'];
    const rows = await getRelayRows();
    expect(rows.find((r) => r.url === 'wss://relay.primal.net')?.source).toBe('default');
    expect(rows.find((r) => r.url === 'wss://mine.example.com')?.source).toBe('user');
  });

  it('labels a relay seen in a NIP-65 list as discovered', async () => {
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://from-nip65.example.com'];
    store[STORAGE_KEYS.RELAY_DISCOVERY] = {
      abc123: { relays: ['wss://from-nip65.example.com'], fetchedAt: Date.now() },
    };
    const rows = await getRelayRows();
    expect(rows.find((r) => r.url === 'wss://from-nip65.example.com')?.source).toBe('discovered');
  });

  it('omits removed relays, so the UI never renders a row that is not in use', async () => {
    store[STORAGE_KEYS.REMOVED_RELAYS] = ['wss://nos.lol'];
    const rows = await getRelayRows();
    expect(rows.map((r) => r.url)).not.toContain('wss://nos.lol');
  });
});

describe('saveRelayPrefs', () => {
  it('normalises both lists on the way in', async () => {
    await saveRelayPrefs(['MINE.example.com/'], ['wss://NOS.lol/']);
    expect(store[STORAGE_KEYS.USER_RELAYS]).toEqual(['wss://mine.example.com']);
    expect(store[STORAGE_KEYS.REMOVED_RELAYS]).toEqual(['wss://nos.lol']);
  });

  it('lets an explicit removal win when a URL appears in both lists', async () => {
    await saveRelayPrefs(['wss://x.example.com'], ['wss://x.example.com']);
    expect(store[STORAGE_KEYS.USER_RELAYS]).toEqual([]);
    expect(store[STORAGE_KEYS.REMOVED_RELAYS]).toEqual(['wss://x.example.com']);
  });
});

describe('mergeDiscoveredRelays', () => {
  it('adds newly discovered relays to the user list', async () => {
    const added = await mergeDiscoveredRelays(['wss://found.example.com']);
    expect(added).toEqual(['wss://found.example.com']);
    expect(store[STORAGE_KEYS.USER_RELAYS]).toEqual(['wss://found.example.com']);
  });

  it('does NOT resurrect a relay the user explicitly removed', async () => {
    store[STORAGE_KEYS.REMOVED_RELAYS] = ['wss://dropped.example.com'];
    const added = await mergeDiscoveredRelays(['wss://dropped.example.com']);
    expect(added).toEqual([]);
    expect(store[STORAGE_KEYS.USER_RELAYS]).toBeUndefined();
  });

  it('skips relays that are already built-in defaults', async () => {
    expect(await mergeDiscoveredRelays(['wss://relay.primal.net'])).toEqual([]);
  });

  it('does not duplicate a relay the user already added', async () => {
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://mine.example.com'];
    expect(await mergeDiscoveredRelays(['wss://mine.example.com/'])).toEqual([]);
    expect(store[STORAGE_KEYS.USER_RELAYS]).toEqual(['wss://mine.example.com']);
  });

  it('is a no-op for an empty discovery result', async () => {
    expect(await mergeDiscoveredRelays([])).toEqual([]);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
