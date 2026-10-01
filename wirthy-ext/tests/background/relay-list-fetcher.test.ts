// NIP-65 (kind-10002) relay discovery. The parse must keep only the relays the
// user WRITES to — publishing to a read-only relay wouldn't reach their
// audience — and the fetch must degrade to [] on every failure path, because a
// discovery failure must never break sign-in.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORAGE_KEYS } from '@/shared/types';

// Controllable kind-10002 lookup. `poolResult` is what pool.get resolves to;
// `getCalls` records the relays each lookup was issued against.
let poolResult: (() => Promise<{ tags: string[][] } | null>) | null = null;
const getCalls: string[][] = [];

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    get(relays: string[]): Promise<{ tags: string[][] } | null> {
      getCalls.push(relays);
      return poolResult ? poolResult() : Promise.resolve(null);
    }
    close(): void { /* no-op */ }
  },
}));

// Import AFTER the mock.
import { fetchPreferredRelays, parseWriteRelays, clearDiscoveryCache } from '@/background/relay-list-fetcher';

const PUBKEY = 'a'.repeat(64);

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  poolResult = null;
  getCalls.length = 0;
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
  store[STORAGE_KEYS.RELAYS] = 'production';
});

describe('parseWriteRelays', () => {
  it('keeps an unmarked relay (NIP-65: no marker means read AND write)', () => {
    expect(parseWriteRelays([['r', 'wss://a.example.com']])).toEqual(['wss://a.example.com']);
  });

  it('keeps an explicit write relay', () => {
    expect(parseWriteRelays([['r', 'wss://a.example.com', 'write']])).toEqual(['wss://a.example.com']);
  });

  it('DROPS a read-only relay — publishing there would not reach the audience', () => {
    expect(parseWriteRelays([
      ['r', 'wss://read.example.com', 'read'],
      ['r', 'wss://write.example.com', 'write'],
    ])).toEqual(['wss://write.example.com']);
  });

  it('ignores non-"r" tags and malformed entries', () => {
    expect(parseWriteRelays([
      ['p', 'wss://not-a-relay.example.com'],
      ['r'],
      ['r', 'https://not-websocket.example.com'],
      ['r', 'wss://good.example.com'],
    ])).toEqual(['wss://good.example.com']);
  });

  it('normalises and de-duplicates', () => {
    expect(parseWriteRelays([
      ['r', 'wss://A.example.com/'],
      ['r', 'wss://a.example.com'],
    ])).toEqual(['wss://a.example.com']);
  });

  it('caps an over-long relay list at 10', () => {
    const tags = Array.from({ length: 25 }, (_, i) => ['r', `wss://r${i}.example.com`]);
    expect(parseWriteRelays(tags)).toHaveLength(10);
  });
});

describe('fetchPreferredRelays', () => {
  it('returns the write relays from the fetched kind-10002', async () => {
    poolResult = () => Promise.resolve({
      tags: [['r', 'wss://mine.example.com', 'write'], ['r', 'wss://read.example.com', 'read']],
    });
    expect(await fetchPreferredRelays(PUBKEY)).toEqual(['wss://mine.example.com']);
  });

  it('returns [] when the identity has no relay list', async () => {
    poolResult = () => Promise.resolve(null);
    expect(await fetchPreferredRelays(PUBKEY)).toEqual([]);
  });

  it('returns [] instead of throwing when the relay lookup rejects', async () => {
    poolResult = () => Promise.reject(new Error('socket died'));
    expect(await fetchPreferredRelays(PUBKEY)).toEqual([]);
  });

  it('caches a hit, so a second call does not touch the network', async () => {
    poolResult = () => Promise.resolve({ tags: [['r', 'wss://mine.example.com']] });
    await fetchPreferredRelays(PUBKEY);
    expect(getCalls).toHaveLength(1);

    const second = await fetchPreferredRelays(PUBKEY);
    expect(second).toEqual(['wss://mine.example.com']);
    expect(getCalls).toHaveLength(1); // no second lookup
  });

  it('caches a MISS too, so an identity with no kind-10002 is not re-fetched every sign-in', async () => {
    poolResult = () => Promise.resolve(null);
    await fetchPreferredRelays(PUBKEY);
    await fetchPreferredRelays(PUBKEY);
    expect(getCalls).toHaveLength(1);
  });

  it('re-fetches once the cache entry is older than the 24h TTL', async () => {
    store[STORAGE_KEYS.RELAY_DISCOVERY] = {
      [PUBKEY]: { relays: ['wss://stale.example.com'], fetchedAt: Date.now() - 25 * 60 * 60 * 1000 },
    };
    poolResult = () => Promise.resolve({ tags: [['r', 'wss://fresh.example.com']] });
    expect(await fetchPreferredRelays(PUBKEY)).toEqual(['wss://fresh.example.com']);
    expect(getCalls).toHaveLength(1);
  });

  it('looks up the relay list on the effective relay set', async () => {
    store[STORAGE_KEYS.USER_RELAYS] = ['wss://mine.example.com'];
    poolResult = () => Promise.resolve(null);
    await fetchPreferredRelays(PUBKEY);
    expect(getCalls[0]).toContain('wss://mine.example.com');
  });
});

describe('clearDiscoveryCache', () => {
  it('forgets only the named identity', async () => {
    store[STORAGE_KEYS.RELAY_DISCOVERY] = {
      [PUBKEY]: { relays: ['wss://a.example.com'], fetchedAt: Date.now() },
      other: { relays: ['wss://b.example.com'], fetchedAt: Date.now() },
    };
    await clearDiscoveryCache(PUBKEY);
    const cache = store[STORAGE_KEYS.RELAY_DISCOVERY] as Record<string, unknown>;
    expect(cache[PUBKEY]).toBeUndefined();
    expect(cache.other).toBeDefined();
  });

  it('is a no-op when the identity was never cached', async () => {
    await clearDiscoveryCache(PUBKEY);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
