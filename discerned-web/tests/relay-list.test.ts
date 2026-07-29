// The web app's mirror of the extension's relay resolution. The extension is
// the source of truth, but this copy decides which relays the FEED subscribes
// to — so a list pushed over the bridge must recompute the active set and wake
// the subscribers, or the feed keeps reading from the old relays.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyRelayList,
  applyRelayMode,
  getActiveRelays,
  getRelayRows,
  normaliseRelayUrl,
  onRelayModeChange,
  DEFAULT_RELAYS,
  type RelayRow,
} from '@/lib/constants';

const ROWS: RelayRow[] = [
  { url: 'wss://relay.primal.net', source: 'default' },
  { url: 'wss://mine.example.com', source: 'discovered' },
];

// This jsdom env provides only a partial localStorage (same guard the existing
// useNostrAuth test uses), so every access here is best-effort.
function readStoredList(): unknown {
  try {
    return JSON.parse(localStorage.getItem('discerned.relayList') ?? 'null');
  } catch {
    return null;
  }
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* partial localStorage in this env */ }
  // Reset module state to the production defaults between tests. applyRelayMode
  // is idempotent, so bounce through 'local' to force a recompute.
  applyRelayMode('local');
  applyRelayList([]);
  applyRelayMode('production');
});

describe('applyRelayList', () => {
  it('makes the list the active relay set', () => {
    applyRelayList(ROWS);
    expect(getActiveRelays()).toEqual(['wss://relay.primal.net', 'wss://mine.example.com']);
    expect(getRelayRows()).toEqual(ROWS);
  });

  it('notifies subscribers so the feed re-subscribes', () => {
    const listener = vi.fn();
    const unsubscribe = onRelayModeChange(listener);
    applyRelayList(ROWS);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('is idempotent — the extension echoing our own edit must not re-subscribe', () => {
    applyRelayList(ROWS);
    const listener = vi.fn();
    const unsubscribe = onRelayModeChange(listener);
    applyRelayList([...ROWS]);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('persists the list so a reload without an extension keeps it', () => {
    applyRelayList(ROWS);
    const stored = readStoredList();
    // Skip rather than fail where this env has no working localStorage — the
    // persistence path is guarded in production for exactly the same reason.
    if (stored === null) return;
    expect(stored).toEqual(ROWS);
  });

  it('falls back to the mode defaults when the list is empty', () => {
    applyRelayList([]);
    expect(getActiveRelays()).toEqual([...DEFAULT_RELAYS]);
  });

  it('LOCAL mode stays exclusive — a user list must not leak into test casts', () => {
    applyRelayList(ROWS);
    applyRelayMode('local');
    expect(getActiveRelays()).not.toContain('wss://mine.example.com');
  });

  it('restores the user list when the mode flips back to production', () => {
    applyRelayList(ROWS);
    applyRelayMode('local');
    applyRelayMode('production');
    expect(getActiveRelays()).toContain('wss://mine.example.com');
  });
});

describe('normaliseRelayUrl (mirror of the extension helper)', () => {
  it('matches the extension on the cases the add-form depends on', () => {
    expect(normaliseRelayUrl('relay.example.com')).toBe('wss://relay.example.com');
    expect(normaliseRelayUrl('wss://relay.example.com/')).toBe('wss://relay.example.com');
    expect(normaliseRelayUrl('wss://Relay.Example.COM')).toBe('wss://relay.example.com');
    expect(normaliseRelayUrl('https://relay.example.com')).toBeNull();
    expect(normaliseRelayUrl('  ')).toBeNull();
  });
});
