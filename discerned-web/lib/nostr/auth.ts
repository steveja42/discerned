// Client-side Nostr auth helpers. Three sign-in paths are supported:
// NIP-07 browser extension (window.nostr), pasted nsec, or generated keypair.
// Only the public key is ever persisted — to localStorage["discerned.auth"].

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  }
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

export async function nip07GetPubkey(): Promise<string> {
  if (!window.nostr) throw new Error('NIP-07 extension not available');
  return window.nostr.getPublicKey();
}

const AUTH_KEY = 'discerned.auth';

export function loadStoredPubkey(): string | null {
  try { return localStorage.getItem(AUTH_KEY); } catch { return null; }
}

export function storePubkey(pubkey: string): void {
  try { localStorage.setItem(AUTH_KEY, pubkey); } catch {}
}

export function clearStoredAuth(): void {
  try { localStorage.removeItem(AUTH_KEY); } catch {}
}
