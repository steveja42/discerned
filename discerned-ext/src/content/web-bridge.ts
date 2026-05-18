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

// knownCount: the number of clips the web app already has. If IndexedDB has
// the same count, skip sending DISCERNED_BRIDGE_CLIPS to avoid redundant transfers.
// Pass 0 to force a full re-send (used on error recovery and cold load).
async function sendBridgeData(knownCount = 0): Promise<void> {
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

  if (clips.length !== knownCount) {
    post({ type: 'DISCERNED_BRIDGE_CLIPS', clips });
    log(LL.NORMAL, `web-bridge: sent ${clips.length} clips to companion app`, 'url:', window.location.href);
  } else {
    log(LL.NORMAL, `web-bridge: clip count unchanged (${clips.length}), skipping BRIDGE_CLIPS`, 'url:', window.location.href);
  }

  // Always send the full category list so the web app's sidebar stays in sync.
  const catStored = await chrome.storage.local.get(STORAGE_KEYS.CATEGORIES);
  const cats = (catStored[STORAGE_KEYS.CATEGORIES] as string[] | undefined) ?? [];
  post({ type: 'DISCERNED_BRIDGE_CATEGORIES', categories: cats });
}

// Listen for messages pushed from the background worker.
chrome.runtime.onMessage.addListener((message: BackgroundMessage) => {
  if (!isContextValid()) return;
  if (message.type === 'PUSH_NEW_CLIP') {
    post({ type: 'DISCERNED_BRIDGE_NEW_CLIP', clip: message.clip });
  }
  if (message.type === 'FORCE_BRIDGE_RESYNC') {
    // Background signals a failed delete/note-update — re-send full clip list
    // so the web app's optimistic state is corrected.
    sendBridgeData(0).catch((err: unknown) => {
      log(LL.ERROR, 'web-bridge: resync failed', err, 'url:', window.location.href);
    });
  }
  if (message.type === 'NAVIGATE_TO_CLIP') {
    // Tell the web page to focus this clip without any URL or React tree change.
    post({ type: 'DISCERNED_BRIDGE_FOCUS_CLIP', clipId: message.clipId });
    log(LL.NORMAL, 'web-bridge: focus clip', message.clipId, 'url:', window.location.href);
  }
  if (message.type === 'PUSH_CATEGORIES') {
    post({ type: 'DISCERNED_BRIDGE_CATEGORIES', categories: message.categories });
  }
});

// Deferred proactive send — yields to DISCERNED_WEB_READY for 200 ms so that
// when the content script reloads into an already-mounted page (e.g. after
// extension reload), the web page's DISCERNED_WEB_READY arrives with the
// correct clipCount and cancels this send, preventing a duplicate fetch.
// If no DISCERNED_WEB_READY arrives within 200 ms (script loaded after READY
// was posted and won't be re-posted), the proactive send fires normally.
// Deduplication: only one sendBridgeData call fires per content script load.
// React Strict Mode double-invokes effects, so DISCERNED_WEB_READY can arrive
// twice within milliseconds. The first arrival wins; subsequent ones are ignored.
let initialSendDone = false;

function sendOnce(clipCount: number, label: string): void {
  if (initialSendDone) return;
  initialSendDone = true;
  sendBridgeData(clipCount).catch((err: unknown) => {
    log(LL.ERROR, `web-bridge: ${label} failed`, err, 'url:', window.location.href);
  });
}

const proactiveTimer = setTimeout(() => {
  sendOnce(0, 'initial sendBridgeData');
}, 200);

// Listen for messages from the web page.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== ORIGIN) return;
  // Note: in an extension content script, `window` is the isolated world's
  // wrapper — distinct from the page's `window` that's the message source.
  // We can't compare e.source === window. Rely on origin only.
  const msg = e.data as WebBridgeInbound | undefined;
  if (msg?.type === 'DISCERNED_WEB_READY') {
    clearTimeout(proactiveTimer);
    sendOnce(msg.clipCount, 'sendBridgeData');
  }
  if (msg?.type === 'DISCERNED_DELETE_CLIPS') {
    chrome.runtime.sendMessage({ type: 'DELETE_CLIPS', ids: msg.ids }).catch(() => { /* non-fatal */ });
  }
  if (msg?.type === 'DISCERNED_UPDATE_NOTE') {
    chrome.runtime.sendMessage({ type: 'UPDATE_CLIP_NOTE', id: msg.id, note: msg.note }).catch(() => { /* non-fatal */ });
  }
  if (msg?.type === 'DISCERNED_IMPORT_CLIPS') {
    chrome.runtime.sendMessage({ type: 'IMPORT_CLIPS', clips: msg.clips }).catch(() => { /* non-fatal */ });
  }
  if (msg?.type === 'DISCERNED_UPDATE_CATEGORIES') {
    chrome.runtime.sendMessage({ type: 'UPDATE_CATEGORIES', categories: msg.categories }).catch(() => { /* non-fatal */ });
  }
});

log(LL.NORMAL, 'Discerned web-bridge loaded', 'url:', window.location.href);
