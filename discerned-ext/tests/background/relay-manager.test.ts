// The relay publisher's ACK-threshold logic. A cast is only reported published
// when enough relays ACK it (1 for the lone local relay, 2 in production) —
// and nostr-tools' quirk of RESOLVING with a "connection failure: …" string
// (instead of rejecting) must be counted as a failure, or casts that never
// reached any relay report success.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/core';
import { STORAGE_KEYS, DEFAULT_RELAYS } from '@/shared/types';

// One controllable publish result per relay URL. SimplePool.publish([url], ev)
// returns an array of per-relay promises; the mock returns [outcome(url)].
const relayOutcomes = new Map<string, () => Promise<string>>();

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish(urls: string[], _event: NostrEvent): Promise<string>[] {
      return urls.map((url) => {
        const outcome = relayOutcomes.get(url);
        return outcome ? outcome() : Promise.resolve('');
      });
    }
    close(): void { /* no-op */ }
  },
}));

// Import AFTER the mock so the module-level singleton wraps the fake pool.
import { publishWithMinimum, getRelayHealth } from '@/background/relay-manager';

const EVENT = { id: 'e'.repeat(64), kind: 1 } as unknown as NostrEvent;

// In the Vitest build __DISCERNED_DEV_BUILD__ is true, so the default relay
// mode is 'local' (a single ws://localhost:7777). Tests that need the 3-relay
// production set store the mode in the chrome.storage.local shim.
function setRelayMode(mode: 'local' | 'production'): void {
  (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    [STORAGE_KEYS.RELAYS]: mode,
  });
}

beforeEach(() => {
  relayOutcomes.clear();
  setRelayMode('local');
});

describe('publishWithMinimum', () => {
  it('succeeds with a single ACK on the lone local relay (threshold 1)', async () => {
    relayOutcomes.set('ws://localhost:7777', () => Promise.resolve(''));
    const { success, results } = await publishWithMinimum(EVENT);
    expect(success).toBe(true);
    expect(results).toEqual([{ relay: 'ws://localhost:7777', success: true }]);
  });

  it('counts a resolved "connection failure: …" string as a FAILURE, not an ACK', async () => {
    // nostr-tools SimplePool resolves (not rejects) with this string when the
    // websocket never connects.
    relayOutcomes.set('ws://localhost:7777', () =>
      Promise.resolve('connection failure: ws://localhost:7777'));
    const { success, results } = await publishWithMinimum(EVENT);
    expect(success).toBe(false);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/connection failure/i);
  });

  it('production: 2 of 3 ACKs meets the threshold', async () => {
    setRelayMode('production');
    relayOutcomes.set('wss://relay.primal.net', () => Promise.resolve(''));
    relayOutcomes.set('wss://nos.lol', () => Promise.resolve(''));
    relayOutcomes.set('wss://relay.snort.social', () => Promise.reject(new Error('rate limited')));

    const { success, results } = await publishWithMinimum(EVENT);
    expect(success).toBe(true);
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.success)).toHaveLength(2);
    const failed = results.find((r) => !r.success);
    expect(failed?.error).toMatch(/rate limited/);
  });

  it('production: 1 of 3 ACKs is below the threshold → failure', async () => {
    setRelayMode('production');
    relayOutcomes.set('wss://relay.primal.net', () => Promise.resolve(''));
    relayOutcomes.set('wss://nos.lol', () => Promise.reject(new Error('down')));
    relayOutcomes.set('wss://relay.snort.social', () =>
      Promise.resolve('connection failure: timed out'));

    const { success } = await publishWithMinimum(EVENT);
    expect(success).toBe(false);
  });

  it('an explicit minimumSuccess override wins over the derived threshold', async () => {
    setRelayMode('production');
    relayOutcomes.set('wss://relay.primal.net', () => Promise.resolve(''));
    relayOutcomes.set('wss://nos.lol', () => Promise.reject(new Error('down')));
    relayOutcomes.set('wss://relay.snort.social', () => Promise.reject(new Error('down')));

    const strict = await publishWithMinimum(EVENT, 3);
    expect(strict.success).toBe(false);
    const lax = await publishWithMinimum(EVENT, 1);
    expect(lax.success).toBe(true);
  });
});

describe('user relay preferences', () => {
  it('publishes to the union of defaults and the user\'s own relays', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.RELAYS]: 'production',
      [STORAGE_KEYS.USER_RELAYS]: ['wss://mine.example.com'],
    });
    for (const url of [...DEFAULT_RELAYS, 'wss://mine.example.com']) {
      relayOutcomes.set(url, () => Promise.resolve(''));
    }
    const { success, results } = await publishWithMinimum(EVENT);
    expect(success).toBe(true);
    expect(results.map((r) => r.relay)).toContain('wss://mine.example.com');
    expect(results).toHaveLength(DEFAULT_RELAYS.length + 1);
  });

  it('skips a default the user removed', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.RELAYS]: 'production',
      [STORAGE_KEYS.REMOVED_RELAYS]: ['wss://relay.snort.social'],
    });
    relayOutcomes.set('wss://relay.primal.net', () => Promise.resolve(''));
    relayOutcomes.set('wss://nos.lol', () => Promise.resolve(''));

    const { success, results } = await publishWithMinimum(EVENT);
    expect(success).toBe(true);
    expect(results.map((r) => r.relay)).not.toContain('wss://relay.snort.social');
  });

  it('keeps the ACK threshold capped at 2 even with a large relay set', async () => {
    const extras = Array.from({ length: 5 }, (_, i) => `wss://extra${i}.example.com`);
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [STORAGE_KEYS.RELAYS]: 'production',
      [STORAGE_KEYS.USER_RELAYS]: extras,
    });
    // Only two relays ACK; the rest fail. Still a success — the threshold is
    // min(count, 2), not "most of them".
    relayOutcomes.set('wss://relay.primal.net', () => Promise.resolve(''));
    relayOutcomes.set('wss://nos.lol', () => Promise.resolve(''));
    for (const url of [...extras, 'wss://relay.snort.social']) {
      relayOutcomes.set(url, () => Promise.reject(new Error('down')));
    }
    const { success } = await publishWithMinimum(EVENT);
    expect(success).toBe(true);
  });
});

describe('getRelayHealth', () => {
  it('summarises healthy/total/percentage', () => {
    expect(getRelayHealth([
      { relay: 'a', success: true },
      { relay: 'b', success: false, error: 'x' },
    ])).toEqual({ healthy: 1, total: 2, percentage: 50 });
  });

  it('reports 0% for an empty result set instead of dividing by zero', () => {
    expect(getRelayHealth([])).toEqual({ healthy: 0, total: 0, percentage: 0 });
  });
});
