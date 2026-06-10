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

// Returns null if the background couldn't be reached (SW asleep on cold start).
// Caller should retry rather than treat this as a definitive "no auth" answer.
async function getAuthInfo(): Promise<{ pubkey: string | null; authMethod: AuthMethod } | null> {
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
    return null;
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

// Returns null if the background couldn't be reached.
async function fetchClips(): Promise<ClipData[] | null> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CLIPS' }) as
      | { success: true; data: { clips: ClipData[] } }
      | { success: false; error: string };
    if (!res.success) return [];
    return res.data.clips;
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

// knownCount: the number of clips the web app already has. If IndexedDB has
// the same count, skip sending DISCERNED_BRIDGE_CLIPS to avoid redundant transfers.
// Pass 0 to force a full re-send (used on error recovery and cold load).
// Returns true only if the background was reachable; caller retries on false.
async function sendBridgeData(knownCount = 0): Promise<boolean> {
  if (!isContextValid()) return false;
  // Auth and clips can be fetched in parallel.
  const [authInfo, clips] = await Promise.all([
    (async () => {
      const info = await getAuthInfo();
      if (info === null) return null;
      // If pro (NIP-07), try to surface the pubkey from storage as a fallback.
      if (info.authMethod === 'nip07' && info.pubkey === null) {
        const stored = await getNip07Pubkey();
        return { ...info, pubkey: stored };
      }
      return info;
    })(),
    fetchClips(),
  ]);

  if (authInfo === null || clips === null) return false;

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
  return true;
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
    return;
  }
  if (message.type === 'NAVIGATE_TO_CLIP') {
    // Tell the web page to focus this clip without any URL or React tree change.
    post({ type: 'DISCERNED_BRIDGE_FOCUS_CLIP', clipId: message.clipId });
    log(LL.NORMAL, 'web-bridge: focus clip', message.clipId, 'url:', window.location.href);
  }
  if (message.type === 'PUSH_CATEGORIES') {
    post({ type: 'DISCERNED_BRIDGE_CATEGORIES', categories: message.categories });
  }
  if (message.type === 'PUSH_PENDING_SIGN') {
    // First-cast handoff from the background: surface a confirm UI in the
    // web app so the user provides a per-origin gesture for window.nostr.
    post({ type: 'DISCERNED_BRIDGE_PENDING_SIGN', id: message.id, event: message.event });
  }
});

// Two distinct concerns:
//   1. SW-asleep retry: the proactive cold-load send may fail because the
//      service worker hasn't woken up yet. Keep retrying until we get real
//      data from the background.
//   2. Page-listener race: on browser launch, the extension's content script
//      can post HELLO before the page's React message listener has attached.
//      The page then sends DISCERNED_WEB_READY to ask for a fresh send — we
//      MUST respond to every READY, not gate it on the proactive having
//      already succeeded. Each READY is the page saying "I'm here now."
let proactiveDone = false;
let proactiveInFlight = false;
let proactiveRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProactiveRetry(): void {
  if (proactiveDone) return;
  if (proactiveRetryTimer !== null) return;
  proactiveRetryTimer = setTimeout(() => {
    proactiveRetryTimer = null;
    runProactive();
  }, 500);
}

function runProactive(): void {
  if (proactiveDone || proactiveInFlight) return;
  proactiveInFlight = true;
  sendBridgeData(0)
    .then((ok: boolean) => {
      proactiveInFlight = false;
      if (ok) {
        proactiveDone = true;
        if (proactiveRetryTimer !== null) {
          clearTimeout(proactiveRetryTimer);
          proactiveRetryTimer = null;
        }
      } else {
        log(LL.NORMAL, 'web-bridge: proactive send got no SW response, will retry', 'url:', window.location.href);
        scheduleProactiveRetry();
      }
    })
    .catch((err: unknown) => {
      proactiveInFlight = false;
      log(LL.ERROR, 'web-bridge: proactive send failed', err, 'url:', window.location.href);
      scheduleProactiveRetry();
    });
}

// Handles every DISCERNED_WEB_READY from the page. Unlike runProactive, this
// does NOT gate on prior success — the page may send READY at any time and
// always wants a fresh response (it might have just hydrated and missed the
// proactive send).
let readyInFlight = false;
function handleReady(clipCount: number): void {
  if (readyInFlight) return;
  readyInFlight = true;
  sendBridgeData(clipCount)
    .then((ok: boolean) => {
      readyInFlight = false;
      if (ok) {
        // A successful READY also satisfies the proactive retry loop.
        proactiveDone = true;
        if (proactiveRetryTimer !== null) {
          clearTimeout(proactiveRetryTimer);
          proactiveRetryTimer = null;
        }
      }
    })
    .catch((err: unknown) => {
      readyInFlight = false;
      log(LL.ERROR, 'web-bridge: READY send failed', err, 'url:', window.location.href);
    });
}

// Deferred proactive send — yields to DISCERNED_WEB_READY for 200 ms so the
// page can supply the correct clipCount before we fetch. If no READY arrives,
// the proactive send fires anyway.
const proactiveTimer = setTimeout(runProactive, 200);

// Listen for messages from the web page.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== ORIGIN) return;
  // Note: in an extension content script, `window` is the isolated world's
  // wrapper — distinct from the page's `window` that's the message source.
  // We can't compare e.source === window. Rely on origin only.
  const msg = e.data as WebBridgeInbound | undefined;
  if (msg?.type === 'DISCERNED_WEB_READY') {
    clearTimeout(proactiveTimer);
    handleReady(msg.clipCount);
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
  if (msg?.type === 'DISCERNED_SIGNED') {
    chrome.runtime.sendMessage({
      type: 'RESOLVE_PENDING_SIGN',
      id: msg.id,
      signed: msg.signed,
    }).catch(() => { /* non-fatal */ });
  }
  if (msg?.type === 'DISCERNED_SIGN_REJECTED') {
    chrome.runtime.sendMessage({
      type: 'REJECT_PENDING_SIGN',
      id: msg.id,
      error: msg.error,
    }).catch(() => { /* non-fatal */ });
  }
  if (msg?.type === 'DISCERNED_SET_NIP07_PUBKEY') {
    chrome.runtime.sendMessage({
      type: 'NIP07_DETECTED',
      hasNIP07: true,
      pubkey: msg.pubkey,
    }).catch(() => { /* non-fatal */ });
  }
  if (msg?.type === 'DISCERNED_REQUEST_CLIP_BODY') {
    const id = msg.id;
    chrome.runtime.sendMessage({ type: 'GET_CLIP_BODY', id })
      .then((res: unknown) => {
        const r = res as { success: boolean; data?: { bodyHtml?: string; thumbnail?: string | null } };
        if (r.success && r.data) {
          post({ type: 'DISCERNED_BRIDGE_CLIP_BODY', id, bodyHtml: r.data.bodyHtml, thumbnail: r.data.thumbnail });
        }
      })
      .catch(() => { /* non-fatal */ });
  }
});

log(LL.NORMAL, 'Discerned web-bridge loaded', 'url:', window.location.href);
