// Shared domain types mirroring the Discerned Chrome extension's data model.
// ClipData is the canonical unit of information flowing through both the extension
// bridge (postMessage) and the public Nostr cast feed.

export type ClipFormat = 'selection' | 'article' | 'full-page' | 'bookmark';
export type SignalLevel = 'Toxic' | 'Noise' | 'Ordinary' | 'Worthwhile' | 'Masterpiece';
export type Category = string;

export interface Capture {
  id: string;
  format: ClipFormat;
  url: string;
  title: string;
  timestamp: number;
  note?: string;
  selectionText?: string;
  selectionContext?: string;
  bodyHtml?: string;
  bodyText?: string;
  thumbnail?: string | null;      // may be an inlined data: URI (private clip render)
  thumbnailUrl?: string | null;   // original http(s) URL — cast as the `image` tag (mirrors discerned-ext)
  imageUrls?: string[];           // content image URLs (any site), cast as NIP-92 imeta tags (mirrors discerned-ext)
  // long-form (kind 30023) — populated by parseEvent from a NIP-23 event
  summary?: string;               // NIP-23 `summary` tag
  markdown?: string;              // NIP-23 event content (snippet-stripped), rendered as markdown
  longFormId?: string;            // NIP-23 `d` tag (== the source clip id)
  kind?: number;                  // the source Nostr event kind (1 or 30023); used for feed dedup
  // cast feed only — author of the published Nostr event (set by parseEvent)
  authorPubkey?: string;
}

export interface Evaluation {
  signal?: SignalLevel;   // absent = unrated
  qualifiers?: string[];  // multi-select tags
  category: Category;
}

export interface ClipData {
  capture: Capture;
  evaluation: Evaluation;
  encrypted: string;
}

export type AuthStatus = 'guest' | 'readonly' | 'connected';

export interface AuthState {
  status: AuthStatus;
  pubkey: string | null;
  source?: 'bridge' | 'manual' | 'nip07';
}
