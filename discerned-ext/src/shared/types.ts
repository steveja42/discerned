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

export type SignalLevel = 'Toxic' | 'Noise' | 'Ordinary' | 'Worthwhile' | 'Masterpiece';
export type Category = string; // Predefined: General, Tech, Finance, Health, Politics, Philosophy, Science, Culture; or custom
export type PublishMode = 'cast' | 'local' | 'both';

// Low → high; star count = index + 1.
export const SIGNAL_LEVELS = ['Toxic', 'Noise', 'Ordinary', 'Worthwhile', 'Masterpiece'] as const;

// Hover-tooltip descriptions for each signal level (shown on the overlay ticks).
export const SIGNAL_DESCRIPTIONS: Record<SignalLevel, string> = {
  Toxic: '1 ★ — Outright fraud, dangerous disinformation, or malicious propaganda.',
  Noise: '2 ★ — Clickbait, low-effort engagement bait, or highly manipulative spin.',
  Ordinary: '3 ★ — Fine for a quick glance. Nothing wrong with it, but nothing that stays with you.',
  Worthwhile: '4 ★ — Solid, high-signal content. It delivered exactly what it promised.',
  Masterpiece: '5 ★ — Exceptional execution. Flawless utility, deep wisdom, or elite artistic craft.',
};

export const signalRank = (lvl: SignalLevel): number =>
  (SIGNAL_LEVELS as readonly string[]).indexOf(lvl) + 1;

// Built-in qualifier chips, grouped as rendered in the overlay.
export const QUALIFIER_GROUPS: readonly { label: string; items: readonly string[] }[] = [
  { label: 'Tone & Style',     items: ['Humorous / Satire', 'Academic / Dense', 'Opinion / Essay'] },
  { label: 'Utility & Format', items: ['Practical Tool', 'Primary Source', 'Quick Read'] },
  { label: 'Longevity',        items: ['Timeless', 'Current Event', 'Passing Trend'] },
] as const;

export interface Evaluation {
  signal?: SignalLevel;   // absent = unrated
  qualifiers: string[];   // [] = none
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
  thumbnail?: string | null;      // may be an inlined data: URI (private clip render)
  thumbnailUrl?: string | null;   // original http(s) URL of the thumbnail — cast as the `image` tag (data: URIs are too large for relays)
  // Original http(s) URLs of the capture's content images (any site), in
  // document order. Generic captures are collected by inlineAllImages' pre-pass
  // (avatars/icons filtered, capped at MAX_CAST_IMAGE_URLS); Tier-0 tweet
  // captures fill it with every tweet photo. Cast as NIP-92 `imeta` tags +
  // appended to the note content so all images render in Nostr clients
  // (data: URIs stay in bodyHtml/selectionText for the private clip).
  imageUrls?: string[];
  // Markdown for a companion kind-30023 long-form, converted from the capture
  // HTML in the content script (turndown needs a DOM the background SW lacks)
  // just before casting. Present only for long-form-eligible captures; not
  // persisted to IndexedDB and not part of any web-bridge/parse shape.
  longFormMarkdown?: string;
  // long-form (kind 30023) — set by the web app's parseEvent when it ingests a
  // NIP-23 event; the extension does not populate these on capture.
  summary?: string;    // NIP-23 `summary` tag
  markdown?: string;   // NIP-23 event content (snippet-stripped), rendered as markdown
  longFormId?: string; // NIP-23 `d` tag (== the source Capture.id)
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
  // `unlocked` is transient session state (the decrypted key lives only in the
  // background SW's memory). It is NOT persisted — only set on the GET_AUTH_STATE
  // response so the overlay can show a locked indicator and prompt for the PIN.
  | { type: 'nsec'; pubkey: string; ncryptsec: string; unlocked?: boolean }; // NIP-49 encrypted blob

// Kind-0 profile metadata for the signed-in identity, fetched from relays and
// cached in chrome.storage.local (STORAGE_KEYS.PROFILE_CACHE). `verified` is
// true only when the nip05 has been checked against its domain's
// /.well-known/nostr.json. `fetchedAt` drives the cache TTL.
export interface OwnProfile {
  pubkey: string;
  name?: string;
  nip05?: string;
  verified?: boolean;
  fetchedAt: number;
}

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
  | { type: 'GET_PROFILE' }
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
  | { type: 'OPEN_HOME'; eventId?: string; autoSignin?: boolean; openSettings?: boolean }
  // Deep-links to the web app's feedback form. `target` prefills the "what is this
  // about" field; the extension version is stamped on by the handler. Deliberately
  // carries NOTHING else — reports become PUBLIC GitHub issues, so auth mode and
  // publish mode are withheld rather than disclosed without the user's say-so.
  | { type: 'OPEN_FEEDBACK'; target?: 'extension' | 'web' | 'both' }
  | { type: 'REGISTER_LOG_TAB' }
  | { type: 'EXTRACT_EMBEDDED_TWEETS' }
  | { type: 'GET_CLIP_BODY'; id: string }
  | { type: 'PUSH_PENDING_SIGN'; id: string; event: Record<string, unknown>; expectedPubkey?: string }
  | { type: 'RESOLVE_PENDING_SIGN'; id: string; signed: Record<string, unknown> }
  | { type: 'REJECT_PENDING_SIGN'; id: string; error: string }
  | { type: 'RELAY_MODE_CHANGED'; mode: RelayMode }
  | { type: 'PUSH_RELAY_MODE'; mode: RelayMode }
  | { type: 'GET_RELAY_LIST' }
  | { type: 'UPDATE_RELAY_LIST'; userRelays: string[]; removedRelays: string[] }
  | { type: 'PUSH_RELAY_LIST'; rows: RelayRow[] }
  | { type: 'GET_NIP07_RELAYS' }
  // Test-only (dev/test builds): build the cast event templates a cast WOULD
  // publish (kind-1 note + companion kind-30023), without signing or publishing.
  // Lets the e2e visual specs render the real published-cast output. The handler
  // is gated on __DISCERNED_DEV_BUILD__ and tree-shaken from production.
  | { type: 'BUILD_CAST'; data: { capture: Capture; evaluation: Evaluation } };

export type BackgroundResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string };

// Storage keys
export const STORAGE_KEYS = {
  AUTH_STATE: 'authState',
  NIP46_CLIENT_KEY: 'nip46ClientKey',
  NSEC_ENCRYPTED: 'nsecEncrypted',
  SETTINGS: 'settings',
  // 'local' | 'production' — the dev relay MODE (see RelayMode below). This is
  // only the BASE of the effective set; the user's own relays live in the two
  // keys after it. Resolve them together via getEffectiveRelays() in shared/relays.ts.
  RELAYS: 'relays',
  // string[] — relays the user added by hand, plus any merged in from their
  // NIP-65 (kind-10002) relay list at sign-in.
  USER_RELAYS: 'userRelays',
  // string[] — relays the user explicitly removed. Applied AFTER the union of
  // defaults + userRelays, so a built-in default can be dropped. Kept as its own
  // list (rather than deleting from userRelays) so re-discovery at the next
  // sign-in can't silently resurrect a relay the user chose to remove.
  REMOVED_RELAYS: 'removedRelays',
  // { [pubkey]: { relays: string[]; fetchedAt: number } } — per-identity NIP-65
  // discovery cache with a 24h TTL. Same shape as PROFILE_CACHE. An EMPTY relays
  // array is cached too, so an identity with no kind-10002 isn't re-fetched on
  // every sign-in.
  RELAY_DISCOVERY: 'relayDiscovery',
  OVERLAY_NUDGE_DISMISSED: 'overlayNudgeDismissed',
  ONBOARDING_SHOWN: 'onboardingShown',
  CAST_COUNT: 'castCount',
  LAST_FORMAT: 'lastFormat',
  LAST_PUBLISH_MODE: 'lastPublishMode',
  LAST_CATEGORY:     'lastCategory',
  QUALIFIERS:        'qualifiers', // persisted custom-qualifier list (sibling of CATEGORIES)
  // Legacy — the overlay checkboxes that wrote these were removed, and capture
  // no longer reads them (it uses the CaptureOptions defaults). Kept only so a
  // future cleanup knows what may still be sitting in an existing install's
  // chrome.storage.local. Nothing should read or write these.
  SMART_ARTICLE_DETECTION: 'smartArticleDetection',
  STRIP_INLINE_STYLES:     'stripInlineStyles',
  CUSTOM_CATEGORIES:       'customCategories', // legacy key — superseded by CATEGORIES
  CATEGORIES:              'categories',
  THEME:                   'theme', // 'system' | 'light' | 'dark' — see resolveThemePref
  PROFILE_CACHE:           'profileCache', // { [pubkey]: OwnProfile } — kind-0 name/nip05, 24h TTL
  // Hex pubkey for which a NIP-07 signer has already surfaced its approval popup
  // (a cast sign succeeded). While the connected identity ≠ this, the cast flow
  // focuses the signing tab so popup-per-sign wallets (nostr-wot) can prompt.
  // Reset implicitly by identity switch (the pubkey no longer matches).
  SIGN_APPROVED_PUBKEY:    'signApprovedPubkey',
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
  | { type: 'DISCERNED_BRIDGE_PENDING_SIGN'; id: string; event: Record<string, unknown>; expectedPubkey?: string }
  | { type: 'DISCERNED_BRIDGE_RELAYS'; mode: RelayMode }
  | { type: 'DISCERNED_BRIDGE_RELAY_LIST'; rows: RelayRow[] };

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
  | { type: 'DISCERNED_SET_RELAY_MODE'; mode: RelayMode }
  | { type: 'DISCERNED_SET_RELAY_LIST'; userRelays: string[]; removedRelays: string[] };

// Default relay list. Mirrored in discerned-web/lib/constants.ts — keep in sync.
// relay.damus.io retired at the end of July 2026; relay.primal.net replaced it.
export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.snort.social',
  //not working 'wss://relay.nostr.band',
] as const;

// Local relay for dev/test builds only. Tree-shaken out of production.
export const LOCAL_RELAY = 'ws://localhost:7777';

// NOTE: there is deliberately no exported ACTIVE_RELAYS / MIN_PUBLISH_ACKS
// constant. The effective relay set is user-dependent (defaults ∪ the user's own
// relays − removals) and can only be resolved asynchronously from
// chrome.storage.local — see getEffectiveRelays() in shared/relays.ts. A
// module-load constant would silently miss the user's relays.

// ── Attribution snippet sentinels (mirrored ext↔web, keep in sync) ───────────
// Every cast prepends a human-readable "Discerned by nostr:… — category · rating
// · [qualifiers]" line so third-party Nostr clients show attribution. The line
// is bracketed by these PURELY INVISIBLE sentinel markers so discerned's own web
// app can strip the whole block by exact boundary before rendering — it renders
// those axes from `l` tags via its glyph UI instead. The markers are runs of
// invisible-math codepoints (U+2061 FUNCTION APPLICATION, U+2062 INVISIBLE
// TIMES, U+2063 INVISIBLE SEPARATOR, U+2064 INVISIBLE PLUS); they render nothing
// in every client and cannot occur in normal captured content. Written as \u
// escapes so no editor can silently eat them. The web app mirror lives in
// discerned-web/lib/nostr/strip-snippet.ts — if you change these, change both.
export const SNIPPET_SENTINEL_OPEN = '⁣⁡⁢⁣';  // invisible open marker
export const SNIPPET_SENTINEL_CLOSE = '⁢⁡⁣⁢'; // invisible close marker

// ── Runtime relay mode (dev toggle) ──────────────────────────────────────────
// A 'local' | 'production' preference persisted in chrome.storage.local under
// STORAGE_KEYS.RELAYS. When unset, the __DISCERNED_DEV_BUILD__ default wins —
// so production users who never touch the toggle behave exactly as before. The
// extension is the source of truth; it mirrors this mode to the web app over the
// bridge (DISCERNED_BRIDGE_RELAYS), and each side resolves its own URLs.
export type RelayMode = 'local' | 'production';

// Resolve the effective mode from a stored value, falling back to the build flag.
export function resolveRelayMode(stored: string | undefined): RelayMode {
  if (stored === 'local' || stored === 'production') return stored;
  return __DISCERNED_DEV_BUILD__ ? 'local' : 'production';
}

// Map a mode to its concrete relay URL list.
export function relaysForMode(mode: RelayMode): string[] {
  return mode === 'local' ? [LOCAL_RELAY] : [...DEFAULT_RELAYS];
}

// Min ACKs derived from an actual relay list (1 for the lone local relay, 2 for production).
export function minAcksFor(relays: readonly string[]): number {
  return Math.min(relays.length, 2);
}

// ── User relay preferences ───────────────────────────────────────────────────
// One row of the relay list as rendered by the management UI. `source` only
// drives the badge and which storage key a removal writes to — every row is
// removable (removing a 'default' records it in REMOVED_RELAYS). Mirrored in
// discerned-web/lib/constants.ts (mirrored, NOT imported — keep in sync).
export type RelaySource = 'default' | 'user' | 'discovered';

export interface RelayRow {
  url: string;
  source: RelaySource;
}

// ── Runtime theme (light / dark / system) ────────────────────────────────────
// A 'system' | 'light' | 'dark' preference persisted in chrome.storage.local
// under STORAGE_KEYS.THEME and shared across every extension surface (overlay,
// preview card, error toast, and the standalone popup/onboarding/connect pages)
// via chrome.storage.onChanged — no message passing needed. The concrete token
// values for each theme live in shared/theme.ts (THEME_TOKENS). Add a theme by
// widening these unions + adding one THEME_TOKENS entry + one picker chip.
export type Theme = 'system' | 'light' | 'dark'; // stored preference
export type ResolvedTheme = 'light' | 'dark';    // theme actually applied

// Resolve the stored preference, defaulting to 'system' when unset/invalid.
export function resolveThemePref(stored: string | undefined): Theme {
  if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  return 'system';
}

// Map a preference to the theme actually applied. 'system' resolves to 'dark'
// only when the OS reports a dark preference, otherwise 'light' — which also
// covers "no OS preference exposed" (prefers-color-scheme resolves to light).
export function resolveEffectiveTheme(pref: Theme, prefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return prefersDark ? 'dark' : 'light';
  return pref;
}
