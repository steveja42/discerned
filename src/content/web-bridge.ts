// Role: Content Script — companion web app bridge
// Description: Runs exclusively on discerned.online. Reads the extension's
//              IndexedDB and auth state, then posts them to the web page via
//              postMessage so the companion app can render the user's clips
//              and display their identity without exposing any private keys.
//
//              Protocol:
//                Web page posts:  { type: 'DISCERNED_WEB_READY' }
//                Bridge replies:  { type: 'DISCERNED_BRIDGE_HELLO', pubkey, authMethod }
//                                 { type: 'DISCERNED_BRIDGE_CLIPS', clips[] }
//
//              Both sides must scope postMessage to window.location.origin to
//              prevent cross-origin spoofing.
// Access: chrome.runtime.sendMessage, IndexedDB (same profile as extension)

import type { AuthState, BackgroundMessage, ClipData, WebBridgeInbound, WebBridgeOutbound } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { LL, log } from '@/shared/logger';

const ORIGIN = window.location.origin;

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function post(msg: WebBridgeOutbound): void {
  window.postMessage(msg, ORIGIN);
}

// ── Auth ────────────────────────────────────────────────────────────────────

type AuthMethod = Extract<WebBridgeOutbound, { type: 'DISCERNED_BRIDGE_HELLO' }>['authMethod'];

async function getAuthInfo(): Promise<{ pubkey: string | null; authMethod: AuthMethod }> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }) as
      | { success: true; data: AuthState }
      | { success: false; error: string };

    if (!res.success) return { pubkey: null, authMethod: null };

    const auth = res.data;
    switch (auth.type) {
      case 'pro':    return { pubkey: null,           authMethod: 'nip07' };
      case 'nip46':  return { pubkey: auth.pubkey,    authMethod: 'nip46' };
      case 'nsec':   return { pubkey: auth.pubkey,    authMethod: 'nsec'  };
      case 'guest':  return { pubkey: null,            authMethod: 'guest' };
    }
  } catch {
    // Background may be sleeping on first load — non-fatal.
    return { pubkey: null, authMethod: null };
  }
}

// For NIP-07 (pro) the pubkey is not stored in chrome.storage — it lives
// in the wallet. We fetch it through the MAIN-world bridge instead.
async function getNip07Pubkey(): Promise<string | null> {
  try {
    // The nip07-bridge content script exposes window.nostr in MAIN world;
    // we can't reach it directly from the isolated world, so we ask the
    // background to sign a dummy request which resolves the pubkey via the
    // same relay path used for casts.
    const stored = await chrome.storage.local.get(STORAGE_KEYS.AUTH_STATE);
    const auth = stored[STORAGE_KEYS.AUTH_STATE] as AuthState | undefined;
    if (auth?.type === 'nip46') return auth.pubkey;
    if (auth?.type === 'nsec')  return auth.pubkey;
    // For pro/guest there is no persistent pubkey in storage.
    return null;
  } catch {
    return null;
  }
}

// ── Clips ────────────────────────────────────────────────────────────────────

async function fetchClips(): Promise<ClipData[]> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CLIPS' }) as
      | { success: true; data: { clips: ClipData[] } }
      | { success: false; error: string };
    if (!res.success) return [];
    return res.data.clips;
  } catch {
    return [];
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function sendBridgeData(): Promise<void> {
  if (!isContextValid()) return;
  // Auth and clips can be fetched in parallel.
  const [authInfo, clips] = await Promise.all([
    (async () => {
      const info = await getAuthInfo();
      // If pro (NIP-07), try to surface the pubkey from storage as a fallback.
      if (info.authMethod === 'nip07' && info.pubkey === null) {
        const stored = await getNip07Pubkey();
        return { ...info, pubkey: stored };
      }
      return info;
    })(),
    fetchClips(),
  ]);

  post({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: authInfo.pubkey, authMethod: authInfo.authMethod });
  post({ type: 'DISCERNED_BRIDGE_CLIPS', clips });

  log(LL.NORMAL, `web-bridge: sent ${clips.length} clips to companion app`, 'url:', window.location.href);
}

// Listen for the background pushing a new clip after a CLIP/CAST completes.
chrome.runtime.onMessage.addListener((message: BackgroundMessage) => {
  if (!isContextValid()) return;
  if (message.type === 'PUSH_NEW_CLIP') {
    post({ type: 'DISCERNED_BRIDGE_NEW_CLIP', clip: message.clip });
  }
});

// Listen for the web page signalling it's ready, then send data.
// Also send immediately in case the script loads after the page already posted READY.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== ORIGIN) return;
  if (e.source !== window) return;
  const msg = e.data as WebBridgeInbound | undefined;
  if (msg?.type === 'DISCERNED_WEB_READY') {
    sendBridgeData().catch((err: unknown) => {
      log(LL.ERROR, 'web-bridge: sendBridgeData failed', err, 'url:', window.location.href);
    });
  }
});

// Proactive send — covers the case where the content script loads after the
// page has already fired DISCERNED_WEB_READY and is waiting.
sendBridgeData().catch((err: unknown) => {
  log(LL.ERROR, 'web-bridge: initial sendBridgeData failed', err, 'url:', window.location.href);
});

log(LL.NORMAL, 'Discerned web-bridge loaded', 'url:', window.location.href);
