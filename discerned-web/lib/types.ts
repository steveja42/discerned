// Shared domain types mirroring the Discerned Chrome extension's data model.
// ClipData is the canonical unit of information flowing through both the extension
// bridge (postMessage) and the public Nostr cast feed.

export type ClipFormat = 'selection' | 'article' | 'full-page' | 'bookmark';
export type SignalLevel = 'Toxic' | 'Noise' | 'Passable' | 'Worthwhile' | 'Masterpiece';
// Legacy axes — still parsed/rendered for old casts and old local clips.
export type InterestLevel = 'Noise' | 'Neutral' | 'Interesting' | 'Insightful' | 'Wise';
export type EthicsLevel = 'Malicious' | 'Misleading' | 'Neutral' | 'Honest' | 'Exemplary';
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
  // cast feed only — author of the published Nostr event (set by parseEvent)
  authorPubkey?: string;
}

export interface Evaluation {
  signal?: SignalLevel;      // absent = unrated (current extension model)
  qualifiers?: string[];     // multi-select tags; absent on legacy data
  interest?: InterestLevel;  // legacy — present only on old casts/clips
  ethics?: EthicsLevel;      // legacy — present only on old casts/clips
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
