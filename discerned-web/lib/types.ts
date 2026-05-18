// Shared domain types mirroring the Discerned Chrome extension's data model.
// ClipData is the canonical unit of information flowing through both the extension
// bridge (postMessage) and the public Nostr cast feed.

export type ClipFormat = 'selection' | 'article' | 'full-page' | 'bookmark';
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
  thumbnail?: string | null;
}

export interface Evaluation {
  interest: InterestLevel;
  ethics: EthicsLevel;
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
