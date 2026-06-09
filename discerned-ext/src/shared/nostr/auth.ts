// Role: Shared (runs in Content Script context) — Nostr authentication
// Description: Detects NIP-07 wallet availability by messaging the MAIN-world bridge, checks for
//              stored NIP-46 tokens, and exposes signWithNIP07 used by the content script entry.
//              Must NOT be imported in the background service worker (no DOM/postMessage there).
// Access: window.postMessage (→ nip07-bridge.ts), chrome.storage.local

import type { AuthState } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';

/**
 * Detect current authentication state
 */
export async function detectAuthState(): Promise<AuthState> {
  // Check for persisted auth state (nip46 / nsec / pro)
  const stored = await chrome.storage.local.get([STORAGE_KEYS.AUTH_STATE]);
  const saved = stored[STORAGE_KEYS.AUTH_STATE] as AuthState | undefined;

  if (saved?.type === 'nip46' || saved?.type === 'nsec') {
    return saved;
  }

  // Try to detect NIP-07 signing extension
  const hasNIP07 = await checkForNIP07();

  if (hasNIP07) {
    return { type: 'pro', hasNIP07: true };
  }

  // Default to guest mode
  return { type: 'guest' };
}

/**
 * Check if window.nostr exists (NIP-07).
 * Sends a postMessage to the MAIN-world bridge (nip07-bridge.ts)
 * which has direct access to window.nostr.
 */
async function checkForNIP07(): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'DISCERNED_NIP07_CHECK_RESPONSE') {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve(event.data.hasNostr as boolean);
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'DISCERNED_NIP07_CHECK' }, '*');
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(false);
    }, 1000);
  });
}

/**
 * Wait until the MAIN-world bridge reports window.nostr is present.
 * Used on freshly opened signing tabs where the wallet's content script may
 * inject window.nostr after our content script attaches. Returns true if
 * window.nostr appears within the timeout, false otherwise.
 */
export async function waitForNIP07(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkForNIP07()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Get public key from NIP-07 extension.
 *
 * Default timeout is 15s — Alby (and similar wallets) wake their service
 * worker on the first getPublicKey call of a session, which can take several
 * seconds before the approval prompt renders. A 3s timeout was the original
 * value but masked legitimate cold-start responses as failures.
 */
export async function getNIP07PublicKey(timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'DISCERNED_NIP07_PUBKEY_RESPONSE') {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve((event.data.pubkey as string) || null);
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'DISCERNED_NIP07_PUBKEY' }, '*');
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Sign event using NIP-07.
 *
 * Default timeout 30s — leaves headroom for the wallet to wake its SW,
 * render the approval prompt, and wait on the user. The earlier 10s value
 * was too tight for cold-start Alby (often ~5–10s just to render).
 */
export async function signWithNIP07(event: object, timeoutMs = 30000): Promise<object> {
  return new Promise((resolve, reject) => {
    const messageId = `sign_${Date.now()}`;
    const handler = (msgEvent: MessageEvent) => {
      if (
        msgEvent.data?.type === 'DISCERNED_NIP07_SIGN_RESPONSE' &&
        msgEvent.data.id === messageId
      ) {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        if (msgEvent.data.error) {
          reject(new Error(msgEvent.data.error as string));
        } else {
          resolve(msgEvent.data.signed as object);
        }
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'DISCERNED_NIP07_SIGN', id: messageId, event }, '*');
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('NIP-07 signing timeout'));
    }, timeoutMs);
  });
}

/**
 * Save auth state to storage
 */
export async function saveAuthState(state: AuthState): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTH_STATE]: state,
  });
}

/**
 * Clear auth state (logout)
 */
export async function clearAuthState(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_STATE,
    STORAGE_KEYS.NIP46_CLIENT_KEY,
    STORAGE_KEYS.NSEC_ENCRYPTED,
  ]);
}
