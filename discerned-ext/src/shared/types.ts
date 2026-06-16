// Role: Shared — type definitions and constants
// Description: Single source of truth for all TypeScript interfaces, union types, message shapes
//              (BackgroundMessage/BackgroundResponse), storage keys, and default relay URLs
//              shared across every component of the extension.
// Access: none (pure types and constants; no runtime APIs)

export type ClipFormat =
  | 'selection'
  | 'article'
  | 'full-page'
  | 'bookmark';

export type LogLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export type AppLogLevel = 0 | 1 | 2 | 3 | 4;
export type LogSource = 'content' | 'popup' | 'onboarding' | 'background';

// Sent from background/popup → active-tab content script so VSCode's page-context
// debugger captures everything in one debug session.
export interface LogRelayMessage {
  type: 'LOG_RELAY';
  source: LogSource;
  level: LogLevel;
  serialized: string[];
}

export type InterestLevel = 'Wise' | 'Insightful' | 'Interesting' | 'Neutral' | 'Noise';
export type EthicsLevel = 'Exemplary' | 'Honest' | 'Neutral' | 'Misleading' | 'Malicious';
export type Category = string; // Predefined: General, Tech, Finance, Health, Politics, Philosophy, Science, Culture; or custom
export type PublishMode = 'cast' | 'local' | 'both';

export interface Evaluation {
  interest: InterestLevel;
  ethics: EthicsLevel;
  category: Category;
}

/**
 * A single unified capture record. Format-specific fields are optional and only
 * populated for the matching format(s). Stable `id` is shared between IndexedDB rows
 * and any future kind-30078 `d`-tag mirror so a companion web app can correlate them.
 */
export interface Capture {
  id: string;
  format: ClipFormat;
  url: string;
  title: string;
  timestamp: number;
  note?: string;
  // selection only
  selectionText?: string;     // sanitized HTML
  selectionContext?: string;  // ±100-char window
  // article / full-page
  bodyHtml?: string;          // sanitized HTML; image src may be data: or https:
  bodyText?: string;          // plain text (Readability textContent or stripped)
  // bookmark / article
  thumbnail?: string | null;
  // cast feed only — author of the published Nostr event (set by the web app's parseEvent)
  authorPubkey?: string;
}

export interface ClipData {
  capture: Capture;
  evaluation: Evaluation;
  encrypted: string; // NIP-44-shaped placeholder; MVP stores plaintext JSON
}

export interface CastData {
  capture: Capture;
  evaluation: Evaluation;
  eventId?: string; // Nostr event ID after publishing
}

// Auth states
export type AuthState =
  | { type: 'guest' }
  | { type: 'pro'; hasNIP07: true; pubkey?: string }
  | { type: 'nip46'; pubkey: string; bunkerRelays: string[]; remotePubkey: string }
  | { type: 'nsec'; pubkey: string; ncryptsec: string }; // NIP-49 encrypted blob

/**
 * Embedded-tweet data harvested from a third-party page that embeds a tweet.
 * Sourced either from the rendered platform.twitter.com iframe (rich, with
 * media) or from the static <blockquote class="twitter-tweet"> fallback markup
 * (author + text + link only). Photo and avatar `src`s are raw https URLs; the
 * page-side substituter calls `inlineImage()` on them to round-trip to base64.
 */
export interface EmbeddedTweetData {
  tweetId: string;
  statusUrl: string;
  displayName: string;
  handle: string;
  badgesHtml: string;
  tweetTextHtml: string;
  photoSrcs: string[];
  videoInfos: { poster: string; duration: string | null; aspectPct: number | null }[];
  avatarSrc: string;
  dateText: string;
  source: 'iframe' | 'blockquote';
}

// Messages between content script and background
export type BackgroundMessage =
  | { type: 'CLIP'; data: { capture: Capture; evaluation: Evaluation } }
  | { type: 'CAST'; data: { capture: Capture; evaluation: Evaluation } }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'GET_CLIPS' }
  | { type: 'DELETE_CLIPS'; ids: string[] }
  | { type: 'UPDATE_CLIP_NOTE'; id: string; note: string }
  | { type: 'IMPORT_CLIPS'; clips: ClipData[] }
  | { type: 'UPDATE_CATEGORIES'; categories: string[] }
  | { type: 'SYNC_CATEGORIES_TO_WEB' }
  | { type: 'PUSH_CATEGORIES'; categories: string[] }
  | { type: 'NIP07_DETECTED'; hasNIP07: boolean; pubkey?: string }
  | { type: 'PUBLISH_KIND_ZERO' }
  | { type: 'CONNECT_NIP46'; bunkerUri: string }
  | { type: 'CONNECT_NSEC'; rawNsec: string; pin: string }
  | { type: 'GENERATE_NSEC' }
  | { type: 'UNLOCK_NSEC'; pin: string }
  | { type: 'DISCONNECT_AUTH' }
  | { type: 'OPEN_ONBOARDING' }
  | { type: 'DISMISS_OVERLAY_NUDGE' }
  | { type: 'SIGN_WITH_NIP07'; event: Record<string, unknown> }
  | { type: 'PING' }
  | { type: 'INLINE_IMAGE'; src: string }
  | { type: 'FETCH_VIDEO_BLOB'; src: string }
  | { type: 'PUSH_NEW_CLIP'; clip: ClipData }
  | { type: 'FORCE_BRIDGE_RESYNC' }
  | { type: 'NAVIGATE_TO_CLIP'; clipId: string }
  | { type: 'GET_CLIP_COUNT' }
  | { type: 'OPEN_LIBRARY'; clipId?: string }
  | { type: 'OPEN_HOME'; eventId?: string; autoSignin?: boolean }
  | { type: 'REGISTER_LOG_TAB' }
  | { type: 'EXTRACT_EMBEDDED_TWEETS' }
  | { type: 'GET_CLIP_BODY'; id: string }
  | { type: 'PUSH_PENDING_SIGN'; id: string; event: Record<string, unknown> }
  | { type: 'RESOLVE_PENDING_SIGN'; id: string; signed: Record<string, unknown> }
  | { type: 'REJECT_PENDING_SIGN'; id: string; error: string }
  | { type: 'RELAY_MODE_CHANGED'; mode: RelayMode }
  | { type: 'PUSH_RELAY_MODE'; mode: RelayMode };

export type BackgroundResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string };

// Storage keys
export const STORAGE_KEYS = {
  AUTH_STATE: 'authState',
  NIP46_CLIENT_KEY: 'nip46ClientKey',
  NSEC_ENCRYPTED: 'nsecEncrypted',
  SETTINGS: 'settings',
  RELAYS: 'relays',
  OVERLAY_NUDGE_DISMISSED: 'overlayNudgeDismissed',
  ONBOARDING_SHOWN: 'onboardingShown',
  CAST_COUNT: 'castCount',
  LAST_FORMAT: 'lastFormat',
  LAST_PUBLISH_MODE: 'lastPublishMode',
  LAST_INTEREST:     'lastInterest',
  LAST_ETHICS:       'lastEthics',
  LAST_CATEGORY:     'lastCategory',
  SMART_ARTICLE_DETECTION: 'smartArticleDetection',
  STRIP_INLINE_STYLES:     'stripInlineStyles',
  CUSTOM_CATEGORIES:       'customCategories', // legacy key — superseded by CATEGORIES
  CATEGORIES:              'categories',
} as const;

// Messages posted between the extension's web-bridge content script and the
// companion web app at discerned.online. Both ends must origin-check before
// acting on these (window.location.origin / e.origin).
export type WebBridgeOutbound =
  | {
      type: 'DISCERNED_BRIDGE_HELLO';
      pubkey: string | null;
      authMethod: 'nip07' | 'nip46' | 'nsec' | 'guest' | null;
    }
  | { type: 'DISCERNED_BRIDGE_CLIPS'; clips: ClipData[] }
  | { type: 'DISCERNED_BRIDGE_NEW_CLIP'; clip: ClipData }
  | { type: 'DISCERNED_BRIDGE_FOCUS_CLIP'; clipId: string }
  | { type: 'DISCERNED_BRIDGE_CATEGORIES'; categories: string[] }
  | { type: 'DISCERNED_BRIDGE_CLIP_BODY'; id: string; bodyHtml?: string; thumbnail?: string | null }
  | { type: 'DISCERNED_BRIDGE_PENDING_SIGN'; id: string; event: Record<string, unknown> }
  | { type: 'DISCERNED_BRIDGE_RELAYS'; mode: RelayMode };

export type WebBridgeInbound =
  | { type: 'DISCERNED_WEB_READY'; clipCount: number }
  | { type: 'DISCERNED_DELETE_CLIPS'; ids: string[] }
  | { type: 'DISCERNED_UPDATE_NOTE'; id: string; note: string }
  | { type: 'DISCERNED_IMPORT_CLIPS'; clips: ClipData[] }
  | { type: 'DISCERNED_UPDATE_CATEGORIES'; categories: string[] }
  | { type: 'DISCERNED_REQUEST_CLIP_BODY'; id: string }
  | { type: 'DISCERNED_SET_NIP07_PUBKEY'; pubkey: string }
  | { type: 'DISCERNED_SIGNED'; id: string; signed: Record<string, unknown> }
  | { type: 'DISCERNED_SIGN_REJECTED'; id: string; error: string }
  | { type: 'DISCERNED_SET_RELAY_MODE'; mode: RelayMode };

// Default relay list
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  //not working 'wss://relay.nostr.band',
] as const;

// Local relay for dev/test builds only. Tree-shaken out of production.
export const LOCAL_RELAY = 'ws://localhost:7777';

// Active relay set. Test/dev REPLACES the public relays so test casts never
// reach the real network; production keeps the wss:// list. This is the
// build-flag DEFAULT — it's the fallback used by resolveRelayMode() below when
// the user hasn't set an explicit relay mode in chrome.storage.local.
export const ACTIVE_RELAYS: readonly string[] = __DISCERNED_TEST_BUILD__
  ? [LOCAL_RELAY]
  : DEFAULT_RELAYS;

// Min ACKs for publish success — derived from relay count, capped at 2 so
// production still requires 2 while a single local relay needs only 1.
export const MIN_PUBLISH_ACKS = Math.min(ACTIVE_RELAYS.length, 2);

// ── Runtime relay mode (dev toggle) ──────────────────────────────────────────
// A 'local' | 'production' preference persisted in chrome.storage.local under
// STORAGE_KEYS.RELAYS. When unset, the build-flag default (ACTIVE_RELAYS) wins —
// so production users who never touch the toggle behave exactly as before. The
// extension is the source of truth; it mirrors this mode to the web app over the
// bridge (DISCERNED_BRIDGE_RELAYS), and each side resolves its own URLs.
export type RelayMode = 'local' | 'production';

// Resolve the effective mode from a stored value, falling back to the build flag.
export function resolveRelayMode(stored: string | undefined): RelayMode {
  if (stored === 'local' || stored === 'production') return stored;
  return __DISCERNED_TEST_BUILD__ ? 'local' : 'production';
}

// Map a mode to its concrete relay URL list.
export function relaysForMode(mode: RelayMode): string[] {
  return mode === 'local' ? [LOCAL_RELAY] : [...DEFAULT_RELAYS];
}

// Min ACKs derived from an actual relay list (1 for the lone local relay, 2 for production).
export function minAcksFor(relays: readonly string[]): number {
  return Math.min(relays.length, 2);
}
