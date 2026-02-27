// Role: Background Service Worker — core orchestrator
// Description: Manages auth state (guest ephemeral key, NIP-07 via content-script delegation,
//              NIP-46 remote signer, or NIP-49-encrypted nsec), creates context menus, routes
//              CLIP/CAST messages, signs and publishes Nostr events, and stores private clips
//              in IndexedDB. No DOM access — NIP-07 signing is delegated to the content script
//              via SIGN_WITH_NIP07 messages.
// Access: chrome.runtime, chrome.contextMenus, chrome.storage, IndexedDB, nostr-tools/pure

import {
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
import type { BackgroundMessage, BackgroundResponse, AuthState, CaptureResult, Evaluation } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { initLogBridge } from '@/shared/logger';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import * as nip49 from 'nostr-tools/nip49';
import type { BunkerPointer } from 'nostr-tools/nip46';

initLogBridge('background');

let currentAuthState: AuthState = { type: 'guest' };
let guestPrivateKey: Uint8Array | null = null;
let nsecPrivateKey: Uint8Array | null = null; // session-only; cleared when SW is killed

// The first tab where NIP-07 was detected becomes the canonical signing tab.
// All casts are routed through this tab so the wallet approves the origin once
// rather than once per domain. Persisted in session storage to survive SW wakeups.
let canonicalNIP07TabId: number | null = null;

/**
 * Restore auth state from storage. Called on SW startup and on install.
 * NIP-07 detection requires DOM — content scripts send NIP07_DETECTED when they load.
 */
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
    // nsecPrivateKey is null here — populated by UNLOCK_NSEC after SW wake
    currentAuthState = saved;
  } else if (saved?.type === 'pro') {
    currentAuthState = saved;
    // Restore the canonical signing tab from session storage so we don't lose
    // the already-approved origin on a SW wakeup within the same browser session.
    const session = await chrome.storage.session.get('canonicalNIP07TabId');
    const storedTabId = session['canonicalNIP07TabId'];
    if (typeof storedTabId === 'number') {
      canonicalNIP07TabId = storedTabId;
    }
  } else {
    currentAuthState = { type: 'guest' };
    if (!guestPrivateKey) guestPrivateKey = generateSecretKey();
  }
  console.log('Discerned auth state:', currentAuthState.type);
}

// Restore on SW startup (not just on install)
restoreAuthState();

/**
 * Initialize on extension install/update
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('Discerned extension installed/updated');

  // Recreate context menu on each install/update to avoid duplicate-ID errors
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'discerned-capture',
      title: 'Discerned: Evaluate → Clip',
      contexts: ['page', 'selection'],
    });
  });

  // Open onboarding tab on fresh install only
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
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'discerned-capture' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_DISCERNED' }).catch(err => {
      console.warn('Discerned: could not reach content script (try refreshing the tab):', err);
    });
  }
});

/**
 * Handle extension icon clicks (only fires when no default_popup is set)
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_DISCERNED' }).catch(err => {
      console.warn('Discerned: could not reach content script (try refreshing the tab):', err);
    });
  }
});

/**
 * Handle messages from content script / popup / onboarding
 */
chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  handleMessage(message, sender.tab?.id)
    .then(sendResponse)
    .catch(error => {
      console.error('Message handler error:', error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });

  // Return true to indicate async response
  return true;
});

/**
 * Main message router
 */
async function handleMessage(message: BackgroundMessage, senderTabId?: number): Promise<BackgroundResponse> {
  switch (message.type) {
    case 'CLIP':
      return handleClip(message.data);

    case 'CAST':
      return handleCast(message.data, senderTabId);

    case 'GET_AUTH_STATE':
      return { success: true, data: currentAuthState };

    case 'NIP07_DETECTED':
      if (message.hasNIP07 && currentAuthState.type === 'guest') {
        currentAuthState = { type: 'pro', hasNIP07: true };
        await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_STATE]: currentAuthState });
        console.log('NIP-07 extension detected — switching to pro mode');
      }
      // Pin the first NIP-07 capable tab as the canonical signing origin.
      // All future casts are routed through this tab so the wallet only
      // needs to approve this origin once rather than once per domain.
      if (message.hasNIP07 && senderTabId !== undefined && canonicalNIP07TabId === null) {
        canonicalNIP07TabId = senderTabId;
        chrome.storage.session.set({ canonicalNIP07TabId: senderTabId }).catch(() => {});
        console.log(`NIP-07 canonical signing tab: ${senderTabId}`);
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

    case 'DISMISS_OVERLAY_NUDGE':
      await chrome.storage.local.set({ [STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED]: true });
      return { success: true };

    case 'SIGN_WITH_NIP07':
      // This message is sent TO the content script, never received here
      return { success: false, error: 'SIGN_WITH_NIP07 is not handled by background' };

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

/**
 * Connect to a NIP-46 bunker via connection URI
 */
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
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

/**
 * Save an nsec (private key) encrypted with a user PIN via NIP-49
 */
async function handleConnectNsec(rawNsec: string, pin: string): Promise<BackgroundResponse> {
  try {
    const decoded = decode(rawNsec.trim());
    if (decoded.type !== 'nsec') {
      return { success: false, error: 'Invalid account key format. It should start with nsec1…' };
    }

    const privateKeyBytes = decoded.data;
    const pubkeyHex = getPublicKey(privateKeyBytes);

    // NIP-49: scrypt-based encryption (may take ~200ms)
    const ncryptsec = nip49.encrypt(privateKeyBytes, pin);

    // Hold decrypted key in session memory
    nsecPrivateKey = privateKeyBytes;

    const newState: AuthState = { type: 'nsec', pubkey: pubkeyHex, ncryptsec };
    currentAuthState = newState;

    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_STATE]: newState,
      [STORAGE_KEYS.NSEC_ENCRYPTED]: ncryptsec,
    });

    return { success: true, data: { pubkey: pubkeyHex } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save account key',
    };
  }
}

/**
 * Unlock nsec after service worker restart (re-derive from stored ncryptsec + PIN)
 */
async function handleUnlockNsec(pin: string): Promise<BackgroundResponse> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.NSEC_ENCRYPTED);
    const ncryptsec = stored[STORAGE_KEYS.NSEC_ENCRYPTED] as string | undefined;
    if (!ncryptsec) {
      return { success: false, error: 'No encrypted account key found' };
    }

    nsecPrivateKey = nip49.decrypt(ncryptsec, pin); // throws on wrong PIN
    return { success: true };
  } catch {
    return { success: false, error: 'Incorrect PIN' };
  }
}

/**
 * Disconnect all auth — return to guest mode
 */
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

/**
 * Handle CLIP action (private storage)
 */
async function handleClip(data: {
  capture: CaptureResult;
  evaluation: Evaluation;
}): Promise<BackgroundResponse> {
  try {
    const payload = prepareClipPayload(data.capture, data.evaluation);

    // For MVP: Just store unencrypted in IndexedDB
    // TODO: Add NIP-44 encryption in Phase 2
    await saveClipLocally({
      id: `clip_${Date.now()}`,
      encrypted: JSON.stringify(payload), // Not actually encrypted yet
      timestamp: Date.now(),
    });

    return { success: true, data: { storage: 'local' } };
  } catch (error) {
    console.error('Clip error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Clip failed',
    };
  }
}

/**
 * Handle CAST action (public signal)
 */
async function handleCast(data: {
  capture: CaptureResult;
  evaluation: Evaluation;
}, senderTabId?: number): Promise<BackgroundResponse> {
  try {
    const eventTemplate = data.capture.type === 'quote'
      ? createQuoteNoteEvent(data.capture, data.evaluation)
      : createResourceNoteEvent(data.capture, data.evaluation);

    const signedEvent = await signEvent(eventTemplate, senderTabId);

    const publishResult = await publishWithMinimum(signedEvent, 2);

    if (!publishResult.success) {
      const health = getRelayHealth(publishResult.results);
      throw new Error(`Failed to cast signal (${health.healthy}/${health.total} relays)`);
    }

    const health = getRelayHealth(publishResult.results);
    console.log(`Successfully cast to ${health.healthy}/${health.total} relays`);

    const stored = await chrome.storage.local.get(STORAGE_KEYS.CAST_COUNT);
    const prev = (stored[STORAGE_KEYS.CAST_COUNT] as number | undefined) ?? 0;
    await chrome.storage.local.set({ [STORAGE_KEYS.CAST_COUNT]: prev + 1 });

    const castPayload = prepareClipPayload(data.capture, data.evaluation);
    await saveClipLocally({
      id: `clip_${Date.now()}`,
      encrypted: JSON.stringify(castPayload),
      timestamp: Date.now(),
    });

    return {
      success: true,
      data: {
        eventId: signedEvent.id,
        relays: publishResult.results,
      },
    };
  } catch (error) {
    console.error('Cast error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Cast failed',
    };
  }
}

/**
 * Return the tab ID to use for NIP-07 signing.
 *
 * Prefers the canonical tab (the first tab where NIP-07 was detected, whose origin the
 * wallet already trusts). If that tab has been closed or discarded, falls back to the
 * sender tab and promotes it to canonical so the wallet only needs one fresh approval.
 */
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

/**
 * Sign an event based on current auth state.
 * - pro: delegated to the canonical content-script tab (wallet approves origin once)
 * - nip46: signed by remote bunker (reconnects on-demand after SW wake)
 * - nsec: signed locally with decrypted key (requires PIN unlock after SW wake)
 * - guest: signed with ephemeral in-memory key
 */
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
      // Canonical tab's content script is unreachable (e.g. page navigated).
      // Clear canonical and retry on the sender tab so the user gets one fresh prompt.
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
    // Guest mode
    if (!guestPrivateKey) guestPrivateKey = generateSecretKey();
    return finalizeEvent(template, guestPrivateKey);
  }
}

/**
 * Save clip to local IndexedDB storage (used for all auth modes, not just guests).
 */
async function saveClipLocally(clip: {
  id: string;
  encrypted: string;
  timestamp: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('discerned', 2);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      // Wrap in try/catch: db.transaction() throws a synchronous NotFoundError
      // if the object store is missing. Without this the error escapes the
      // Promise entirely and becomes an uncaught exception.
      try {
        const db = request.result;
        const transaction = db.transaction(['clips'], 'readwrite');
        const store = transaction.objectStore('clips');

        store.add(clip);

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };

        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('clips')) {
        db.createObjectStore('clips', { keyPath: 'id' });
      }
    };
  });
}

// Log when service worker starts
console.log('Discerned background service worker loaded');
