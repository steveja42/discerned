// Axis vocabularies and category definitions shared across feed, glyphs, and filters.
// Hue values drive oklch() colour generation for category swatches in the UI.

import { LL, log } from '@/lib/logger';
import type { ClipData } from '@/lib/types';

// Signal rating vocabulary (low → high) — mirrors SIGNAL_LEVELS in the extension's shared/types.ts.
export const SIGNAL_LEVELS = ['Toxic', 'Noise', 'Passable', 'Worthwhile', 'Masterpiece'] as const;

// Built-in qualifier chips — mirrors QUALIFIER_GROUPS in the extension's shared/types.ts. Keep in sync.
export const QUALIFIER_GROUPS: readonly { label: string; items: readonly string[] }[] = [
  { label: 'Tone & Style',     items: ['Humorous / Satire', 'Academic / Dense', 'Opinion / Essay'] },
  { label: 'Utility & Format', items: ['Practical Tool', 'Primary Source', 'Quick Read'] },
  { label: 'Longevity',        items: ['Timeless', 'Current Event', 'Passing Trend'] },
] as const;
export const BUILTIN_QUALIFIERS: readonly string[] = QUALIFIER_GROUPS.flatMap((g) => g.items);

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

// Star count for a signal level (1–5). Returns 0 for unknown/unrated.
export const signalRank = (lvl: string | undefined): number =>
  lvl ? SIGNAL_LEVELS.indexOf(lvl as typeof SIGNAL_LEVELS[number]) + 1 : 0;

// Union of built-ins (canonical order) with any custom qualifiers on loaded clips, deduped.
export function deriveQualifierOptions(clips: ClipData[]): string[] {
  const seen = new Set(BUILTIN_QUALIFIERS);
  const extras = new Set<string>();
  for (const c of clips) for (const q of c.evaluation.qualifiers ?? []) if (!seen.has(q)) extras.add(q);
  return [...BUILTIN_QUALIFIERS, ...[...extras].sort()];
}

// OR match: clip passes if it has at least one selected qualifier. Empty selection = no filter.
export function matchesQualifiers(clipQuals: string[] | undefined, selected: string[]): boolean {
  if (selected.length === 0) return true;
  const have = clipQuals ?? [];
  return selected.some((q) => have.includes(q));
}

// OR match: clip passes if its exact signal level is one of the selected. Empty = no filter.
export function matchesSignal(clipSignal: string | undefined, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return clipSignal !== undefined && selected.includes(clipSignal);
}

// Mirrors DEFAULT_RELAYS in discerned-ext/src/shared/types.ts — keep in sync.
// relay.damus.io retired at the end of July 2026; relay.primal.net replaced it.
export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.snort.social',
] as const;

// Active relay set. When NEXT_PUBLIC_LOCAL_RELAY is set (dev/test via .env.local)
// it REPLACES the public relays so the feed reads only local test casts; unset
// in production → real wss:// relays. Mirrors the relay-mode default in the extension's
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

// ── User relay preferences (mirrors the extension's shared/relays.ts) ─────────
// The EXTENSION is the source of truth: it owns chrome.storage.local and is the
// only side that publishes. This mirror exists so (a) the feed subscribes to the
// same set, and (b) the settings UI still works standalone when no extension is
// installed (localStorage-backed). Keep RelaySource/RelayRow and
// normaliseRelayUrl in sync with discerned-ext/src/shared/{types,relays}.ts.

export type RelaySource = 'default' | 'user' | 'discovered';

export interface RelayRow {
  url: string;
  source: RelaySource;
}

const RELAY_LIST_STORAGE_KEY = 'discerned.relayList';

/**
 * Canonicalise a relay URL so the same relay can't appear twice under two
 * spellings. Returns null when the input can't be a relay URL.
 * Mirror of normaliseRelayUrl in the extension's shared/relays.ts.
 */
export function normaliseRelayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null;
  if (!url.hostname) return null;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

let currentMode: RelayMode = DEFAULT_RELAY_MODE;
let activeRelays: string[] = relaysForMode(currentMode);
// The relay list as last pushed by the extension (or restored from localStorage).
// Empty means "no list known" — the mode defaults apply.
let relayRows: RelayRow[] = [];
const listeners = new Set<() => void>();

export function getActiveRelays(): string[] {
  return activeRelays;
}

export function getRelayRows(): RelayRow[] {
  return relayRows;
}

// Recompute the active set from mode + rows. In LOCAL mode the local relay is
// exclusive (test casts must never reach the public network), matching
// getEffectiveRelays() in the extension.
function recomputeActiveRelays(): void {
  if (currentMode === 'local' || relayRows.length === 0) {
    activeRelays = relaysForMode(currentMode);
    return;
  }
  activeRelays = relayRows.map((r) => r.url);
}

/**
 * Adopt a relay list (pushed by the extension over the bridge, or edited
 * locally). Recomputes the active set and notifies subscribers so the feed
 * re-subscribes. Idempotent — an unchanged list is a no-op, which keeps the
 * extension's echo of our own edit from causing a redundant re-subscribe.
 */
export function applyRelayList(rows: RelayRow[]): void {
  const same =
    rows.length === relayRows.length &&
    rows.every((r, i) => r.url === relayRows[i].url && r.source === relayRows[i].source);
  if (same) return;

  relayRows = rows;
  recomputeActiveRelays();
  log(LL.NORMAL, `[nostr] relay list → ${rows.length} relay(s):`, activeRelays);
  try {
    localStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify(rows));
  } catch { /* SSR / blocked storage */ }
  listeners.forEach((fn) => fn());
}

// Restore the last-known relay list on boot so the feed uses it before (or
// without) an extension push. Called alongside initRelayModeFromStorage.
export function initRelayListFromStorage(): void {
  try {
    const raw = localStorage.getItem(RELAY_LIST_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const rows = parsed.filter(
      (r): r is RelayRow => !!r && typeof r.url === 'string' && typeof r.source === 'string',
    );
    if (rows.length > 0) applyRelayList(rows);
  } catch { /* SSR / blocked storage / malformed JSON */ }
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
  // Via recompute (not relaysForMode directly) so switching back to production
  // restores the user's relay list rather than the bare defaults.
  recomputeActiveRelays();
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
