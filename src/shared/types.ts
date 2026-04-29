// Role: Shared — type definitions and constants
// Description: Single source of truth for all TypeScript interfaces, union types, message shapes
//              (BackgroundMessage/BackgroundResponse), storage keys, and default relay URLs
//              shared across every component of the extension.
// Access: none (pure types and constants; no runtime APIs)

export type ClipFormat =
  | 'selection'
  | 'article'
  | 'simplified-article'
  | 'full-page'
  | 'bookmark';

export type LogLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';
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
export type EthicsLevel = 'Exemplary' | 'Honest' | 'Biased' | 'Neutral' | 'Misleading' | 'Malicious';
export type Category = string; // Predefined: General, Tech, Finance, Health, Politics, Philosophy, Science, Culture; or custom

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
  // article / simplified-article / full-page
  bodyHtml?: string;          // sanitized HTML; image src may be data: or https:
  bodyText?: string;          // plain text (Readability textContent or stripped)
  // bookmark / article
  thumbnail?: string | null;
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
  | { type: 'pro'; hasNIP07: true }
  | { type: 'nip46'; pubkey: string; bunkerRelays: string[]; remotePubkey: string }
  | { type: 'nsec'; pubkey: string; ncryptsec: string }; // NIP-49 encrypted blob

// Messages between content script and background
export type BackgroundMessage =
  | { type: 'CLIP'; data: { capture: Capture; evaluation: Evaluation } }
  | { type: 'CAST'; data: { capture: Capture; evaluation: Evaluation } }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'NIP07_DETECTED'; hasNIP07: boolean }
  | { type: 'CONNECT_NIP46'; bunkerUri: string }
  | { type: 'CONNECT_NSEC'; rawNsec: string; pin: string }
  | { type: 'UNLOCK_NSEC'; pin: string }
  | { type: 'DISCONNECT_AUTH' }
  | { type: 'OPEN_ONBOARDING' }
  | { type: 'DISMISS_OVERLAY_NUDGE' }
  | { type: 'SIGN_WITH_NIP07'; event: Record<string, unknown> }
  | { type: 'INLINE_IMAGE'; src: string };

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
} as const;

// Default relay list
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  //not working 'wss://relay.nostr.band',
] as const;
