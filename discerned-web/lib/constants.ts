// Axis vocabularies and category definitions shared across feed, glyphs, and filters.
// Hue values drive oklch() colour generation for category swatches in the UI.

import { LL, log } from '@/lib/logger';

export const INTEREST_LEVELS = ['Noise', 'Neutral', 'Interesting', 'Insightful', 'Wise'] as const;
export const ETHICS_LEVELS = ['Malicious', 'Misleading', 'Neutral', 'Honest', 'Exemplary'] as const;

export const CATEGORIES: Record<string, { label: string; hue: number }> = {
  General:    { label: 'General',    hue: 60 },
  Tech:       { label: 'Tech',       hue: 220 },
  Finance:    { label: 'Finance',    hue: 155 },
  Health:     { label: 'Health',     hue: 25 },
  Politics:   { label: 'Politics',   hue: 0 },
  Philosophy: { label: 'Philosophy', hue: 270 },
  Science:    { label: 'Science',    hue: 200 },
  Culture:    { label: 'Culture',    hue: 320 },
};

export const interestRank = (lvl: string): number =>
  INTEREST_LEVELS.indexOf(lvl as typeof INTEREST_LEVELS[number]);

export const ethicsRank = (lvl: string): number =>
  ETHICS_LEVELS.indexOf(lvl as typeof ETHICS_LEVELS[number]);

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
] as const;

// Active relay set. When NEXT_PUBLIC_LOCAL_RELAY is set (dev/test via .env.local)
// it REPLACES the public relays so the feed reads only local test casts; unset
// in production → real wss:// relays. Mirrors ACTIVE_RELAYS in the extension's
// shared/types.ts, but resolved via env var (Next idiom) rather than a build flag.
//
// The env var supplies the DEFAULT mode; a runtime dev toggle (synced from the
// extension over the bridge, or set locally in SettingsModal) can override it
// via applyRelayMode() without a rebuild. Subscription code reads getActiveRelays()
// at call time, so flipping the mode + re-subscribing picks up the new set.
const LOCAL_RELAY = process.env.NEXT_PUBLIC_LOCAL_RELAY;

export type RelayMode = 'local' | 'production';

// Mode the env var resolves to: local when NEXT_PUBLIC_LOCAL_RELAY is set, else production.
export const DEFAULT_RELAY_MODE: RelayMode = LOCAL_RELAY ? 'local' : 'production';

export function relaysForMode(mode: RelayMode): string[] {
  // Fall back to the conventional local relay if the env var is unset but a
  // local override is requested (e.g. via the bridge from a local-mode extension).
  return mode === 'local' ? [LOCAL_RELAY ?? 'ws://localhost:7777'] : [...DEFAULT_RELAYS];
}

let currentMode: RelayMode = DEFAULT_RELAY_MODE;
let activeRelays: string[] = relaysForMode(currentMode);
const listeners = new Set<() => void>();

export function getActiveRelays(): string[] {
  return activeRelays;
}

export function getCurrentRelayMode(): RelayMode {
  return currentMode;
}

// Subscribe to relay-mode changes; returns an unsubscribe fn. Hooks use this to
// tear down and re-establish their Nostr subscriptions when the mode flips.
export function onRelayModeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Apply a new relay mode. Idempotent — a no-op when the mode is unchanged, which
// prevents a redundant re-subscribe when the extension echoes the mode back after
// the web app's own toggle set it. Persists to localStorage and notifies listeners.
export function applyRelayMode(mode: RelayMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  activeRelays = relaysForMode(mode);
  log(LL.NORMAL, `[nostr] relay mode → ${mode} (${activeRelays.length} relay(s)):`, activeRelays);
  try { localStorage.setItem('discerned.relayMode', mode); } catch { /* SSR / blocked storage */ }
  listeners.forEach((fn) => fn());
}

// Apply the persisted localStorage mode on boot so the feed uses the saved mode
// when no extension is connected to push one. Runs from a provider effect after
// the TopBar/feed have mounted, so it routes through applyRelayMode to notify
// listeners (count badge + feed re-subscribe) when the stored mode differs from
// the env default. A no-op when they already agree.
export function initRelayModeFromStorage(): void {
  try {
    const m = localStorage.getItem('discerned.relayMode');
    if (m === 'local' || m === 'production') applyRelayMode(m);
  } catch { /* SSR / blocked storage */ }
  // Always log the resolved startup relay set, even when no override applied
  // (applyRelayMode only logs on an actual change).
  log(LL.NORMAL, `[nostr] initial relay mode: ${currentMode} (${activeRelays.length} relay(s)):`, activeRelays);
}

// Back-compat: the initial active set (env-var resolution). New code should call
// getActiveRelays() so a runtime toggle is honoured.
export const ACTIVE_RELAYS: readonly string[] = relaysForMode(DEFAULT_RELAY_MODE);
