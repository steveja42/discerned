// Role: Background Service Worker — core orchestrator
// Description: Manages auth state (guest ephemeral key, NIP-07 via content-script delegation,
//              NIP-46 remote signer, or NIP-49-encrypted nsec), creates context menus, routes
//              CLIP/CAST messages, signs and publishes Nostr events, stores private clips
//              in IndexedDB, and provides a privileged image-inlining endpoint for rich-format
//              captures. Also toggles the toolbar action's popup per-tab so chrome:// pages
//              show a friendly stub while normal pages launch the overlay directly.
// Access: chrome.runtime, chrome.contextMenus, chrome.action, chrome.tabs, chrome.storage,
//         IndexedDB, fetch (for INLINE_IMAGE), nostr-tools/pure

import {
  CAST_INLINE_BODY_MAX_CHARS,
  createQuoteNoteEvent,
  createResourceNoteEvent,
} from '@/shared/nostr/events';
import { prepareClipPayload } from '@/shared/nostr/encryption';
import { publishWithMinimum, getRelayHealth } from './relay-manager';
import {
  connectFromBunkerUri,
  getOrCreateBunkerSigner,
  invalidateBunkerSigner,
} from '@/shared/nostr/nip46-manager';
import type { BackgroundMessage, BackgroundResponse, AuthState, Capture, Evaluation, ClipData } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { LL, log, setLogRelayTabs } from '@/shared/logger';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import * as nip49 from 'nostr-tools/nip49';
import type { BunkerPointer } from 'nostr-tools/nip46';


let currentAuthState: AuthState = { type: 'guest' };
let guestPrivateKey: Uint8Array | null = null;
let nsecPrivateKey: Uint8Array | null = null; // session-only; cleared when SW is killed

// The first tab where NIP-07 was detected becomes the canonical signing tab.
// All casts are routed through this tab so the wallet approves the origin once
// rather than once per domain. Persisted in session storage to survive SW wakeups.
let canonicalNIP07TabId: number | null = null;

// Ordered list of tab IDs (most-recent first) that have a live content script
// and have registered as log relay targets. Only logRelayTabIds[0] receives logs.
let logRelayTabIds: number[] = [];

function registerLogTab(tabId: number): void {
  logRelayTabIds = [tabId, ...logRelayTabIds.filter(id => id !== tabId)];
  setLogRelayTabs(logRelayTabIds);
}

function unregisterLogTab(tabId: number): void {
  logRelayTabIds = logRelayTabIds.filter(id => id !== tabId);
  setLogRelayTabs(logRelayTabIds);
}

chrome.tabs.onRemoved.addListener(unregisterLogTab);

const POPUP_STUB_PATH = 'src/popup/popup.html';
const RESTRICTED_URL_PREFIXES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:', 'file:'];
const MAX_IMAGE_BYTES = 2_000_000;
const DISCERNED_URL_PATTERNS = ['https://discerned.online/*', 'http://localhost:3000/*'];

async function pushClipToWebApp(clip: ClipData): Promise<void> {
  const tabs = await chrome.tabs.query({ url: DISCERNED_URL_PATTERNS });
  const message: BackgroundMessage = { type: 'PUSH_NEW_CLIP', clip };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => { /* non-fatal */ });
  }
}

// Tells the web-bridge content script to re-send the full clip list to the page.
// Used after a failed delete or note-update so the web app's optimistic state
// is corrected to match the actual IndexedDB contents.
async function pushResyncToWebApp(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: DISCERNED_URL_PATTERNS });
  const message: BackgroundMessage = { type: 'FORCE_BRIDGE_RESYNC' };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => { /* non-fatal */ });
  }
}

const LIBRARY_URL_PATTERNS = ['https://discerned.online/library*', 'http://localhost:3000/library*'];
// Base URLs derived from DISCERNED_URL_PATTERNS (strip trailing /*).
const DISCERNED_BASE_URLS = DISCERNED_URL_PATTERNS.map(p => p.replace(/\/\*$/, ''));

// Returns localhost base if any localhost tab is open (dev server running), else production.
async function resolveBaseUrl(): Promise<string> {
  const localTabs = await chrome.tabs.query({ url: 'http://localhost:3000/*' });
  return localTabs.length > 0 ? DISCERNED_BASE_URLS[1] : DISCERNED_BASE_URLS[0];
}

async function openLibraryTab(clipId: string): Promise<void> {
  const base = await resolveBaseUrl();
  const url = `${base}/library?clip=${encodeURIComponent(clipId)}`;
  const [existing] = await chrome.tabs.query({ url: LIBRARY_URL_PATTERNS });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId !== undefined) {
      chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
  } else {
    await chrome.tabs.create({ url });
  }
}

const isBfcachePortError = (err: unknown) =>
  ((err as { message?: string })?.message ?? '').includes('back/forward cache');

async function restoreAuthState(): Promise<void> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.AUTH_STATE,
    STORAGE_KEYS.NIP46_CLIENT_KEY,
    STORAGE_KEYS.NSEC_ENCRYPTED,
  ]);

  const saved = stored[STORAGE_KEYS.AUTH_STATE] as AuthState | undefined;

  if (saved?.type === 'nip46') {
    currentAuthState = saved;
  } else if (saved?.type === 'nsec') {
    currentAuthState = saved;
  } else if (saved?.type === 'pro') {
    currentAuthState = saved;
    const session = await chrome.storage.session.get('canonicalNIP07TabId');
    const storedTabId = session['canonicalNIP07TabId'];
    if (typeof storedTabId === 'number') {
      canonicalNIP07TabId = storedTabId;
    }
  } else {
    currentAuthState = { type: 'guest' };
    if (!guestPrivateKey) guestPrivateKey = generateSecretKey();
  }
  log(LL.DEBUG, 'Discerned auth state:', currentAuthState.type);
}

restoreAuthState();

chrome.runtime.onInstalled.addListener(async (details) => {
  log(LL.NORMAL, 'Discerned extension installed/updated');

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'discerned-capture',
      title: 'Discerned: Evaluate → Clip',
      contexts: ['page', 'selection'],
    });
  });

  if (details.reason === 'install') {
    const s = await chrome.storage.local.get(STORAGE_KEYS.ONBOARDING_SHOWN);
    if (!s[STORAGE_KEYS.ONBOARDING_SHOWN]) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
      chrome.storage.local.set({ [STORAGE_KEYS.ONBOARDING_SHOWN]: true });
    }
  }

  await restoreAuthState();
});

/**
 * Right-click context menu activates the overlay on the active tab.
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'discerned-capture' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_DISCERNED' }).catch(err => {
      if (isBfcachePortError(err)) return;
      log(LL.WARN, 'Discerned: could not reach content script (try refreshing the tab):', err);
    });
  }
});

/**
 * Toolbar icon click — fires only when no per-tab popup is set (see updatePopupForTab below).
 * On normal pages this opens the overlay; on restricted pages a per-tab popup is set
 * so onClicked never runs there.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_DISCERNED' }).catch(err => {
      if (isBfcachePortError(err)) return;
      log(LL.WARN, 'Discerned: could not reach content script (try refreshing the tab):', err);
    });
  }
});

// ── Per-tab popup toggling ──────────────────────────────────────────────────
//
// On chrome:// / file:// / edge:// / etc., content scripts can't run, so the overlay
// path would silently fail. Set a small popup stub for those tabs that explains why.
// On normal pages, clear the popup so chrome.action.onClicked fires and launches the
// overlay directly (Evernote-style icon click).

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some(p => url.startsWith(p));
}

async function updatePopupForTab(tabId: number, url: string | undefined): Promise<void> {
  try {
    if (isRestrictedUrl(url)) {
      await chrome.action.setPopup({ tabId, popup: POPUP_STUB_PATH });
    } else {
      await chrome.action.setPopup({ tabId, popup: '' });
    }
  } catch {
    // Tab may have closed; non-fatal.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePopupForTab(tabId, tab.url);
  } catch { /* tab gone; ignore */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    void updatePopupForTab(tabId, tab.url);
  }
});

// ── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  handleMessage(message, sender.tab?.id)
    .then(sendResponse)
    .catch(error => {
      log(LL.ERROR, 'Message handler error:', error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });
  return true;
});

async function handleMessage(message: BackgroundMessage, senderTabId?: number): Promise<BackgroundResponse> {
  switch (message.type) {
    case 'CLIP':
      return handleClip(message.data);

    case 'CAST':
      return handleCast(message.data, senderTabId);

    case 'GET_AUTH_STATE':
      return { success: true, data: currentAuthState };

    case 'GET_CLIPS':
      return handleGetClips();

    case 'DELETE_CLIPS':
      return handleDeleteClips(message.ids);

    case 'UPDATE_CLIP_NOTE':
      return handleUpdateClipNote(message.id, message.note);

    case 'NIP07_DETECTED':
      if (message.hasNIP07 && currentAuthState.type === 'guest') {
        currentAuthState = { type: 'pro', hasNIP07: true };
        await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_STATE]: currentAuthState });
        log(LL.NORMAL, 'NIP-07 extension detected — switching to pro mode');
      }
      if (message.hasNIP07 && senderTabId !== undefined && canonicalNIP07TabId === null) {
        canonicalNIP07TabId = senderTabId;
        chrome.storage.session.set({ canonicalNIP07TabId: senderTabId }).catch(() => {});
        log(LL.DEBUG, `NIP-07 canonical signing tab: ${senderTabId}`);
      }
      return { success: true };

    case 'CONNECT_NIP46':
      return handleConnectNip46(message.bunkerUri);

    case 'CONNECT_NSEC':
      return handleConnectNsec(message.rawNsec, message.pin);

    case 'UNLOCK_NSEC':
      return handleUnlockNsec(message.pin);

    case 'DISCONNECT_AUTH':
      return handleDisconnectAuth();

    case 'OPEN_ONBOARDING':
      chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
      return { success: true };

    case 'OPEN_LIBRARY':
      openLibraryTab(message.clipId).catch(() => {});
      return { success: true };

    case 'OPEN_HOME':
      resolveBaseUrl().then(base => chrome.tabs.create({ url: base })).catch(() => {});
      return { success: true };

    case 'DISMISS_OVERLAY_NUDGE':
      await chrome.storage.local.set({ [STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED]: true });
      return { success: true };

    case 'SIGN_WITH_NIP07':
      return { success: false, error: 'SIGN_WITH_NIP07 is not handled by background' };

    case 'INLINE_IMAGE':
      return handleInlineImage(message.src);

    case 'REGISTER_LOG_TAB':
      if (senderTabId !== undefined) registerLogTab(senderTabId);
      return { success: true };

    case 'PUSH_NEW_CLIP':
    case 'FORCE_BRIDGE_RESYNC':
      // These are background→content messages; the background never receives them.
      return { success: false, error: 'Not handled by background' };

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

// ── Auth handlers (unchanged from prior implementation) ─────────────────────

async function handleConnectNip46(bunkerUri: string): Promise<BackgroundResponse> {
  try {
    const result = await connectFromBunkerUri(bunkerUri);
    const newState: AuthState = {
      type: 'nip46',
      pubkey: result.pubkey,
      bunkerRelays: result.bunkerRelays,
      remotePubkey: result.remotePubkey,
    };
    currentAuthState = newState;
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_STATE]: newState,
      [STORAGE_KEYS.NIP46_CLIENT_KEY]: result.clientKeyHex,
    });
    return { success: true, data: { pubkey: result.pubkey } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Connection failed' };
  }
}

async function handleConnectNsec(rawNsec: string, pin: string): Promise<BackgroundResponse> {
  try {
    const decoded = decode(rawNsec.trim());
    if (decoded.type !== 'nsec') {
      return { success: false, error: 'Invalid account key format. It should start with nsec1…' };
    }
    const privateKeyBytes = decoded.data;
    const pubkeyHex = getPublicKey(privateKeyBytes);
    const ncryptsec = nip49.encrypt(privateKeyBytes, pin);
    nsecPrivateKey = privateKeyBytes;
    const newState: AuthState = { type: 'nsec', pubkey: pubkeyHex, ncryptsec };
    currentAuthState = newState;
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_STATE]: newState,
      [STORAGE_KEYS.NSEC_ENCRYPTED]: ncryptsec,
    });
    return { success: true, data: { pubkey: pubkeyHex } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save account key' };
  }
}

async function handleUnlockNsec(pin: string): Promise<BackgroundResponse> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.NSEC_ENCRYPTED);
    const ncryptsec = stored[STORAGE_KEYS.NSEC_ENCRYPTED] as string | undefined;
    if (!ncryptsec) return { success: false, error: 'No encrypted account key found' };
    nsecPrivateKey = nip49.decrypt(ncryptsec, pin);
    return { success: true };
  } catch {
    return { success: false, error: 'Incorrect PIN' };
  }
}

async function handleDisconnectAuth(): Promise<BackgroundResponse> {
  invalidateBunkerSigner();
  nsecPrivateKey = null;
  currentAuthState = { type: 'guest' };
  guestPrivateKey = generateSecretKey();
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_STATE,
    STORAGE_KEYS.NIP46_CLIENT_KEY,
    STORAGE_KEYS.NSEC_ENCRYPTED,
  ]);
  return { success: true };
}

// ── Image inlining (privileged fetch) ───────────────────────────────────────

async function handleInlineImage(src: string): Promise<BackgroundResponse> {
  try {
    if (!/^https?:/i.test(src)) {
      return { success: false, error: 'Unsupported scheme' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(src, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };

    const declaredLen = res.headers.get('content-length');
    if (declaredLen && parseInt(declaredLen, 10) > MAX_IMAGE_BYTES) {
      return { success: false, error: 'Image too large' };
    }
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) {
      return { success: false, error: 'Image too large' };
    }
    const dataUri = await blobToDataUri(blob);
    return { success: true, data: { dataUri } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// ── CLIP / CAST handlers ────────────────────────────────────────────────────

async function handleGetClips(): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned', DB_VERSION);
    request.onerror = () => resolve({ success: false, error: 'IndexedDB open failed' });
    request.onupgradeneeded = () => { /* read-only probe; no schema changes */ };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips')) {
        db.close();
        resolve({ success: true, data: { clips: [] } });
        return;
      }
      try {
        const tx = db.transaction(['clips'], 'readonly');
        const getAllReq = tx.objectStore('clips').getAll();
        getAllReq.onsuccess = () => {
          db.close();
          const rows = (getAllReq.result as ClipRow[]) ?? [];
          const clips: ClipData[] = [];
          for (const row of rows) {
            try { clips.push(JSON.parse(row.encrypted) as ClipData); } catch { /* skip */ }
          }
          clips.sort((a, b) => b.capture.timestamp - a.capture.timestamp);
          resolve({ success: true, data: { clips } });
        };
        getAllReq.onerror = () => { db.close(); resolve({ success: true, data: { clips: [] } }); };
      } catch {
        db.close();
        resolve({ success: true, data: { clips: [] } });
      }
    };
  });
}

async function handleDeleteClips(ids: string[]): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned', DB_VERSION);
    request.onerror = () => {
      void pushResyncToWebApp();
      resolve({ success: false, error: 'IndexedDB open failed' });
    };
    request.onupgradeneeded = () => { /* probe only */ };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips') || ids.length === 0) {
        db.close();
        resolve({ success: true });
        return;
      }
      try {
        const tx = db.transaction(['clips'], 'readwrite');
        const store = tx.objectStore('clips');
        let pending = ids.length;
        let failed = false;
        for (const id of ids) {
          const req = store.delete(id);
          req.onerror = () => {
            if (!failed) { failed = true; db.close(); void pushResyncToWebApp(); resolve({ success: false, error: 'Delete failed' }); }
          };
          req.onsuccess = () => {
            pending--;
            if (pending === 0 && !failed) {
              db.close();
              log(LL.DEBUG, `background: deleted ${ids.length} clip(s)`, ids.join(', '));
              resolve({ success: true });
            }
          };
        }
      } catch {
        db.close();
        void pushResyncToWebApp();
        resolve({ success: false, error: 'Transaction failed' });
      }
    };
  });
}

async function handleUpdateClipNote(id: string, note: string): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned', DB_VERSION);
    request.onerror = () => {
      void pushResyncToWebApp();
      resolve({ success: false, error: 'IndexedDB open failed' });
    };
    request.onupgradeneeded = () => { /* probe only */ };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips')) {
        db.close();
        void pushResyncToWebApp();
        resolve({ success: false, error: 'No clips store' });
        return;
      }
      try {
        const tx = db.transaction(['clips'], 'readwrite');
        const store = tx.objectStore('clips');
        const getReq = store.get(id);
        getReq.onerror = () => { db.close(); void pushResyncToWebApp(); resolve({ success: false, error: 'Read failed' }); };
        getReq.onsuccess = () => {
          const row = getReq.result as ClipRow | undefined;
          if (!row) { db.close(); void pushResyncToWebApp(); resolve({ success: false, error: 'Clip not found' }); return; }
          try {
            const payload = JSON.parse(row.encrypted) as ClipData;
            payload.capture.note = note || undefined;
            row.encrypted = JSON.stringify(payload);
            const putReq = store.put(row);
            putReq.onerror = () => { db.close(); void pushResyncToWebApp(); resolve({ success: false, error: 'Write failed' }); };
            putReq.onsuccess = () => {
              db.close();
              log(LL.DEBUG, `background: updated note for clip ${id}`, `note: "${note}"`);
              resolve({ success: true });
            };
          } catch {
            db.close();
            void pushResyncToWebApp();
            resolve({ success: false, error: 'Parse failed' });
          }
        };
      } catch {
        db.close();
        void pushResyncToWebApp();
        resolve({ success: false, error: 'Transaction failed' });
      }
    };
  });
}

async function handleClip(data: { capture: Capture; evaluation: Evaluation }): Promise<BackgroundResponse> {
  try {
    const payload = prepareClipPayload(data.capture, data.evaluation);
    await saveClipLocally({
      id: data.capture.id,
      encrypted: JSON.stringify(payload), // NIP-44 encryption pending — stored as plaintext JSON for now
      timestamp: data.capture.timestamp,
    });
    void pushClipToWebApp({ capture: data.capture, evaluation: data.evaluation, encrypted: '' });
    return { success: true, data: { storage: 'local' } };
  } catch (error) {
    log(LL.ERROR, 'Clip error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Clip failed' };
  }
}

async function handleCast(
  data: { capture: Capture; evaluation: Evaluation },
  senderTabId?: number,
): Promise<BackgroundResponse> {
  try {
    const eventTemplate = buildCastTemplate(data.capture, data.evaluation);
    const signedEvent = await signEvent(eventTemplate, senderTabId);
    const publishResult = await publishWithMinimum(signedEvent, 2);

    if (!publishResult.success) {
      const health = getRelayHealth(publishResult.results);
      throw new Error(`Failed to cast signal (${health.healthy}/${health.total} relays)`);
    }

    const health = getRelayHealth(publishResult.results);
    log(LL.NORMAL, `Successfully cast to ${health.healthy}/${health.total} relays`);

    const stored = await chrome.storage.local.get(STORAGE_KEYS.CAST_COUNT);
    const prev = (stored[STORAGE_KEYS.CAST_COUNT] as number | undefined) ?? 0;
    await chrome.storage.local.set({ [STORAGE_KEYS.CAST_COUNT]: prev + 1 });

    return {
      success: true,
      data: { eventId: signedEvent.id, relays: publishResult.results },
    };
  } catch (error) {
    log(LL.ERROR, 'Cast error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Cast failed' };
  }
}

/**
 * Build the kind-1 event template for the given Capture. Selection casts include the
 * quoted text inline (as today). Bookmark casts URL-summary only. Article / simplified
 * / full-page casts URL-summary by default; if `bodyText` is short enough to safely
 * fit on relays, the body is inlined too.
 */
function buildCastTemplate(capture: Capture, evaluation: Evaluation) {
  if (capture.format === 'selection') {
    return createQuoteNoteEvent(capture, evaluation);
  }
  if (capture.format === 'bookmark') {
    return createResourceNoteEvent(capture, evaluation);
  }
  // article / full-page
  const bodyText = capture.bodyText?.trim() ?? '';
  let inline: string | undefined;
  if (bodyText.length > 0) {
    inline = bodyText.length <= CAST_INLINE_BODY_MAX_CHARS
      ? bodyText
      : bodyText.slice(0, CAST_INLINE_BODY_MAX_CHARS) + '\n\n[Content truncated due to length]';
  }
  return createResourceNoteEvent(capture, evaluation, inline);
}

// ── Signing ─────────────────────────────────────────────────────────────────

async function resolveSigningTab(fallbackTabId?: number): Promise<number> {
  if (canonicalNIP07TabId !== null) {
    try {
      const tab = await chrome.tabs.get(canonicalNIP07TabId);
      if (tab && !tab.discarded) return canonicalNIP07TabId;
    } catch {
      // Tab was closed.
    }
    canonicalNIP07TabId = null;
    chrome.storage.session.remove('canonicalNIP07TabId').catch(() => {});
  }
  if (!fallbackTabId) throw new Error('No tab available for NIP-07 signing');
  canonicalNIP07TabId = fallbackTabId;
  chrome.storage.session.set({ canonicalNIP07TabId: fallbackTabId }).catch(() => {});
  return fallbackTabId;
}

async function signEvent(
  template: Parameters<typeof finalizeEvent>[0],
  senderTabId?: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (currentAuthState.type === 'pro') {
    const tabId = await resolveSigningTab(senderTabId);
    let response: { signed?: object; error?: string } | null;
    try {
      response = await chrome.tabs.sendMessage(tabId, {
        type: 'SIGN_WITH_NIP07',
        event: template,
      }) as typeof response;
    } catch {
      if (tabId !== senderTabId && senderTabId) {
        canonicalNIP07TabId = null;
        chrome.storage.session.remove('canonicalNIP07TabId').catch(() => {});
        response = await chrome.tabs.sendMessage(senderTabId, {
          type: 'SIGN_WITH_NIP07',
          event: template,
        }) as typeof response;
        canonicalNIP07TabId = senderTabId;
        chrome.storage.session.set({ canonicalNIP07TabId: senderTabId }).catch(() => {});
      } else {
        throw new Error('NIP-07 signing failed: content script unreachable');
      }
    }
    if (!response) throw new Error('NIP-07 content script did not respond');
    if (response.error) throw new Error(response.error);
    return response.signed;
  } else if (currentAuthState.type === 'nip46') {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.NIP46_CLIENT_KEY);
    const clientKeyHex = stored[STORAGE_KEYS.NIP46_CLIENT_KEY] as string;
    const bp: BunkerPointer = {
      pubkey: currentAuthState.remotePubkey,
      relays: currentAuthState.bunkerRelays,
      secret: null,
    };
    const signer = await getOrCreateBunkerSigner(clientKeyHex, bp);
    return signer.signEvent(template);
  } else if (currentAuthState.type === 'nsec') {
    if (!nsecPrivateKey) throw new Error('PIN_REQUIRED');
    return finalizeEvent(template, nsecPrivateKey);
  } else {
    if (!guestPrivateKey) guestPrivateKey = generateSecretKey();
    return finalizeEvent(template, guestPrivateKey);
  }
}

// ── IndexedDB ───────────────────────────────────────────────────────────────

const DB_VERSION = 3;

interface ClipRow {
  id: string;
  encrypted: string;
  timestamp: number;
}

async function saveClipLocally(clip: ClipRow): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('discerned', DB_VERSION);
    request.onerror = () => reject(request.error);

    request.onupgradeneeded = (event) => {
      const target = event.target as IDBOpenDBRequest;
      const db = target.result;
      const tx = target.transaction;
      if (!db.objectStoreNames.contains('clips')) {
        db.createObjectStore('clips', { keyPath: 'id' });
        return;
      }
      // v2 → v3: translate legacy capture.type → format and pull selection-specific
      // fields out of `content`/`context` into the unified shape.
      if (tx) {
        const store = tx.objectStore('clips');
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const row = cursor.value as ClipRow;
          try { migrateRowInPlace(row); cursor.update(row); } catch { /* skip malformed */ }
          cursor.continue();
        };
      }
    };

    request.onsuccess = () => {
      try {
        const db = request.result;
        const transaction = db.transaction(['clips'], 'readwrite');
        const store = transaction.objectStore('clips');
        store.put(clip);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
  });
}

function migrateRowInPlace(row: ClipRow): void {
  if (!row?.encrypted) return;
  const payload = JSON.parse(row.encrypted) as { capture?: Record<string, unknown>; [k: string]: unknown };
  const cap = payload.capture;
  if (!cap || typeof cap !== 'object') return;

  if (typeof cap.format === 'string') return; // already migrated

  const legacyType = cap.type as 'quote' | 'resource' | undefined;
  if (legacyType === 'quote') {
    cap.format = 'selection';
    if (typeof cap.content === 'string') cap.selectionText = cap.content;
    if (typeof cap.context === 'string') cap.selectionContext = cap.context;
    delete cap.content;
    delete cap.context;
  } else if (legacyType === 'resource') {
    cap.format = 'bookmark';
    // title / thumbnail already match the new shape
  }
  delete cap.type;
  if (!cap.id) cap.id = row.id;
  if (!cap.title) cap.title = '';
  row.encrypted = JSON.stringify(payload);
}

log(LL.NORMAL, 'Discerned background service worker loaded');

// Broadcast to all tabs so their content scripts re-register as log relay targets.
// This re-populates logRelayTabIds after the service worker is killed and restarted.
chrome.tabs.query({}).then(tabs => {
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      chrome.tabs.sendMessage(tab.id, { type: 'SW_STARTED' }).catch(() => { /* no content script — ok */ });
    }
  }
});
