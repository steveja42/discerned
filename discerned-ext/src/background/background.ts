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
  createProfileEvent,
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
import type { BackgroundMessage, BackgroundResponse, AuthState, Capture, Evaluation, ClipData, EmbeddedTweetData } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { LL, log, setLogRelayTabs } from '@/shared/logger';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { decode, nsecEncode, npubEncode } from 'nostr-tools/nip19';
import * as nip49 from 'nostr-tools/nip49';
import type { BunkerPointer } from 'nostr-tools/nip46';


let currentAuthState: AuthState = { type: 'guest' };
let guestPrivateKey: Uint8Array | null = null;
let nsecPrivateKey: Uint8Array | null = null; // session-only; cleared when SW is killed

// All NIP-07 signing is routed through a single tab on the discerned origin, so
// the wallet approves that one origin once per session rather than once per
// website the user casts from. signingTabIsOurs records whether we created the
// tab (a minimized window) vs. reused one the user already had open — we only
// ever close/manage a tab we created. Both persist in session storage to
// survive SW wakeups.
let signingTabId: number | null = null;
let signingTabIsOurs = false;

// Pending NIP-07 kind-1 cast sign requests routed through the web app.
// NIP-07 casts always go through the web app Confirm button so the wallet only
// ever needs to approve discerned.online, not every site the overlay opens on.
// In-memory only — if the SW dies mid-cast the user retries.
interface PendingSignEntry {
  resolve: (signed: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingSigns = new Map<string, PendingSignEntry>();

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

async function pushCategoriesToWebApp(categories: string[]): Promise<void> {
  const tabs = await chrome.tabs.query({ url: DISCERNED_URL_PATTERNS });
  const message: BackgroundMessage = { type: 'PUSH_CATEGORIES', categories };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => { /* non-fatal */ });
  }
}

async function handleImportClips(clips: ClipData[]): Promise<BackgroundResponse> {
  try {
    for (const clip of clips) {
      await saveClipLocally({
        id: clip.capture.id,
        encrypted: JSON.stringify(clip),
        timestamp: clip.capture.timestamp,
      });
    }
    await pushResyncToWebApp();
    return { success: true, data: { count: clips.length } };
  } catch (error) {
    log(LL.ERROR, 'Import clips error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Import failed' };
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

// Discernments home — match the bare base URL with optional trailing slash and
// query/hash, but NOT subpaths like /library or /about.
const DISCERNMENTS_URL_PATTERNS = [
  'https://discerned.online/',
  'https://discerned.online/?*',
  'https://discerned.online/#*',
  'http://localhost:3000/',
  'http://localhost:3000/?*',
  'http://localhost:3000/#*',
];

async function openDiscernmentsTab(autoSignin?: boolean): Promise<void> {
  const base = await resolveBaseUrl();
  const url = autoSignin ? `${base}/?signin=1` : base;
  const [existing] = await chrome.tabs.query({ url: DISCERNMENTS_URL_PATTERNS });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true, url: autoSignin ? url : undefined });
    if (existing.windowId !== undefined) {
      chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
  } else {
    await chrome.tabs.create({ url });
  }
}

async function openLibraryTab(clipId?: string): Promise<void> {
  const base = await resolveBaseUrl();
  const url = clipId ? `${base}/library?clip=${encodeURIComponent(clipId)}` : `${base}/library`;
  const [existing] = await chrome.tabs.query({ url: LIBRARY_URL_PATTERNS });
  if (existing?.id !== undefined) {
    // Tab is already on the library — activate it and navigate client-side via
    // the content script so React state (ClipStoreContext) is preserved and
    // there is no full reload, flash, or redundant clip re-send.
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    if (clipId) {
      chrome.tabs.sendMessage(existing.id, { type: 'NAVIGATE_TO_CLIP', clipId } satisfies BackgroundMessage)
        .catch(() => { /* non-fatal — clip will appear via PUSH_NEW_CLIP */ });
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
    const session = await chrome.storage.session.get(['signingTabId', 'signingTabIsOurs']);
    const storedTabId = session['signingTabId'];
    if (typeof storedTabId === 'number') {
      signingTabId = storedTabId;
      signingTabIsOurs = session['signingTabIsOurs'] === true;
    }
  } else {
    currentAuthState = { type: 'guest' };
    if (!guestPrivateKey) guestPrivateKey = generateSecretKey();
  }
  log(LL.DEBUG, 'Discerned auth state:', currentAuthState.type);
}

const INITIAL_CATEGORIES = ['General', 'Tech', 'Finance', 'Health', 'Politics', 'Philosophy', 'Science', 'Culture'];

// Migrate legacy customCategories → categories, or seed the initial list if absent.
async function seedCategories(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.CATEGORIES, STORAGE_KEYS.CUSTOM_CATEGORIES]);
  if (stored[STORAGE_KEYS.CATEGORIES]) return; // already migrated
  const legacy = (stored[STORAGE_KEYS.CUSTOM_CATEGORIES] as string[] | undefined) ?? [];
  const merged = [...INITIAL_CATEGORIES, ...legacy.filter(c => !INITIAL_CATEGORIES.map(x => x.toLowerCase()).includes(c.toLowerCase()))];
  await chrome.storage.local.set({ [STORAGE_KEYS.CATEGORIES]: merged });
}

void restoreAuthState();
seedCategories();

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
      return handleCast(message.data);

    case 'GET_AUTH_STATE':
      return { success: true, data: currentAuthState };

    case 'GET_CLIP_COUNT':
      return handleGetClipCount();

    case 'GET_CLIPS':
      return handleGetClips();

    case 'GET_CLIP_BODY':
      return handleGetClipBody(message.id);

    case 'DELETE_CLIPS':
      return handleDeleteClips(message.ids);

    case 'UPDATE_CLIP_NOTE':
      return handleUpdateClipNote(message.id, message.note);

    case 'NIP07_DETECTED':
      if (message.hasNIP07 && currentAuthState.type === 'guest') {
        currentAuthState = { type: 'pro', hasNIP07: true, pubkey: message.pubkey };
        await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_STATE]: currentAuthState });
        log(LL.NORMAL, 'NIP-07 extension detected — switching to pro mode');
      } else if (message.hasNIP07 && currentAuthState.type === 'pro' && message.pubkey && !currentAuthState.pubkey) {
        currentAuthState = { ...currentAuthState, pubkey: message.pubkey };
        await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_STATE]: currentAuthState });
      }
      return { success: true };

    case 'PUBLISH_KIND_ZERO':
      return handlePublishKind0(senderTabId);

    case 'RESOLVE_PENDING_SIGN':
      resolvePendingSign(message.id, message.signed);
      return { success: true };

    case 'REJECT_PENDING_SIGN':
      rejectPendingSign(message.id, message.error);
      return { success: true };

    case 'CONNECT_NIP46':
      return handleConnectNip46(message.bunkerUri);

    case 'CONNECT_NSEC':
      return handleConnectNsec(message.rawNsec, message.pin);

    case 'GENERATE_NSEC':
      return handleGenerateNsec();

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
      // message.eventId is accepted for a future deep-link to the cast; for now we
      // open the bare discernments feed (the just-cast event may not have propagated
      // to the subscribed relays yet, so deep-linking would risk a transient miss).
      openDiscernmentsTab(message.autoSignin).catch(() => {});
      return { success: true };

    case 'DISMISS_OVERLAY_NUDGE':
      await chrome.storage.local.set({ [STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED]: true });
      return { success: true };

    case 'SIGN_WITH_NIP07':
      return { success: false, error: 'SIGN_WITH_NIP07 is not handled by background' };

    case 'INLINE_IMAGE':
      return handleInlineImage(message.src);

    case 'FETCH_VIDEO_BLOB':
      return handleFetchVideoBlob(message.src);

    case 'EXTRACT_EMBEDDED_TWEETS':
      return handleExtractEmbeddedTweets(senderTabId);

    case 'REGISTER_LOG_TAB':
      if (senderTabId !== undefined) registerLogTab(senderTabId);
      return { success: true };

    case 'IMPORT_CLIPS':
      return handleImportClips(message.clips);

    case 'UPDATE_CATEGORIES':
      await chrome.storage.local.set({ [STORAGE_KEYS.CATEGORIES]: message.categories });
      return { success: true };

    case 'SYNC_CATEGORIES_TO_WEB': {
      const catStored = await chrome.storage.local.get(STORAGE_KEYS.CATEGORIES);
      const cats = (catStored[STORAGE_KEYS.CATEGORIES] as string[] | undefined) ?? [];
      await pushCategoriesToWebApp(cats);
      return { success: true };
    }

    case 'PUSH_NEW_CLIP':
    case 'FORCE_BRIDGE_RESYNC':
    case 'NAVIGATE_TO_CLIP':
    case 'PUSH_CATEGORIES':
    case 'PUSH_PENDING_SIGN':
      // These are background→content messages; the background never receives them.
      // (PUSH_PENDING_SIGN is sent TO the web-bridge content script, not received here.)
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

/**
 * Generate a brand-new Nostr keypair and return it ONCE for the user to back up.
 * Does NOT persist, activate, or unlock anything — the key becomes real only when
 * the user explicitly Stores it (CONNECT_NSEC) with a PIN. The secret is never logged.
 */
function handleGenerateNsec(): BackgroundResponse {
  try {
    const privateKeyBytes = generateSecretKey();
    const nsec = nsecEncode(privateKeyBytes);
    const npub = npubEncode(getPublicKey(privateKeyBytes));
    return { success: true, data: { npub, nsec } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate key' };
  }
}

async function handleUnlockNsec(pin: string): Promise<BackgroundResponse> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.NSEC_ENCRYPTED);
    const ncryptsec = stored[STORAGE_KEYS.NSEC_ENCRYPTED] as string | undefined;
    if (!ncryptsec) return { success: false, error: 'No stored key found' };
    nsecPrivateKey = nip49.decrypt(ncryptsec, pin);
    const nsec = nsecEncode(nsecPrivateKey);
    const npub = npubEncode(getPublicKey(nsecPrivateKey));
    return { success: true, data: { npub, nsec } };
  } catch {
    return { success: false, error: 'Incorrect PIN' };
  }
}

async function handleDisconnectAuth(): Promise<BackgroundResponse> {
  invalidateBunkerSigner();
  nsecPrivateKey = null;
  currentAuthState = { type: 'guest' };
  guestPrivateKey = generateSecretKey();
  await closeOwnSigningTab();
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_STATE,
    STORAGE_KEYS.NIP46_CLIENT_KEY,
    STORAGE_KEYS.NSEC_ENCRYPTED,
  ]);
  return { success: true };
}

// ── Embedded-tweet iframe extraction (cross-origin via executeScript) ───────

/**
 * Enumerate platform.twitter.com tweet embed iframes in the sender's tab,
 * inject `extractFromTweetEmbed` into each, and return the harvested data.
 * The injected function runs inside the embed iframe's origin (X's), reading
 * the rendered tweet DOM. Returned image URLs are raw https; the page-side
 * substituter inlines them via the existing INLINE_IMAGE path.
 */
async function handleExtractEmbeddedTweets(tabId?: number): Promise<BackgroundResponse> {
  if (tabId === undefined) return { success: false, error: 'no tab id' };
  let frames: chrome.webNavigation.GetAllFrameResultDetails[];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  } catch (err) {
    log(LL.WARN, 'EXTRACT_EMBEDDED_TWEETS: getAllFrames failed', err);
    return { success: true, data: [] as EmbeddedTweetData[] };
  }
  const tweetFrames = frames.filter(f =>
    /^https:\/\/platform\.twitter\.com\/embed\/Tweet\.html/i.test(f.url)
  );
  if (tweetFrames.length === 0) return { success: true, data: [] as EmbeddedTweetData[] };

  log(LL.DEBUG, `EXTRACT_EMBEDDED_TWEETS: found ${tweetFrames.length} tweet embed frame(s) in tab ${tabId}`);

  const results = await Promise.all(tweetFrames.map(async (frame) => {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: extractFromTweetEmbed,
      });
      return injected?.[0]?.result ?? null;
    } catch (err) {
      log(LL.WARN, `EXTRACT_EMBEDDED_TWEETS: executeScript failed for frame ${frame.frameId}`, err);
      return null;
    }
  }));

  return { success: true, data: results.filter((d): d is EmbeddedTweetData => d !== null) };
}

/**
 * Runs INSIDE the platform.twitter.com/embed/Tweet.html iframe via
 * chrome.scripting.executeScript. Must be self-contained — no imports, no
 * closures over the background module. References only standard DOM globals.
 *
 * Selectors are verified against the live embed-page DOM (see the
 * embedded-tweet-probe spec). The embed page uses a subset of twitter.com's
 * testIds: [data-testid="UserAvatar-Container-{handle}"], [data-testid="tweetText"],
 * [data-testid="icon-verified"], [data-testid="tweet-text-show-more-link"].
 * Handle and avatar come from the container's testId + child img.
 *
 * Returns raw https URLs; the page-side substituter inlines them via
 * INLINE_IMAGE (the background's privileged fetch).
 *
 * Returns null on extraction failure so the page falls back to blockquote data.
 */
function extractFromTweetEmbed(): unknown {
  try {
    const article = document.querySelector('article') ?? document.body;
    if (!article) return null;

    // Status URL: the "Visit this post on X" link is the canonical one and
    // points at https://x.com/{handle}/status/{id}. Strip query string.
    // Resolved first because in `-onlyvideo` mode the rest of the tweet UI
    // may not render (no avatar container, no profile link, no text), and
    // statusUrl alone is enough to give us a valid tweetId + handle.
    const statusAnchor = article.querySelector('a[aria-label="Visit this post on X"]') as HTMLAnchorElement | null
      ?? (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null);
    const rawStatus = statusAnchor?.getAttribute('href') ?? '';
    const statusUrl = rawStatus.split('?')[0] ?? '';
    const tweetIdMatch = statusUrl.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';
    if (!tweetId) return null;

    // Handle: from UserAvatar-Container-{handle} testId, or fall back to the
    // status URL path /{handle}/status/{id}.
    const avatarContainer = article.querySelector('[data-testid^="UserAvatar-Container-"]');
    let handle = (avatarContainer?.getAttribute('data-testid') ?? '')
      .replace(/^UserAvatar-Container-/, '');
    if (!handle) {
      const handleFromUrl = statusUrl.match(/\/\/(?:twitter|x)\.com\/([^/]+)\/status\//i);
      if (handleFromUrl) handle = handleFromUrl[1];
    }

    // Avatar img inside the container (may be absent in -onlyvideo mode).
    const avatarImg = avatarContainer?.querySelector('img');
    const avatarSrc = avatarImg?.getAttribute('src') ?? '';

    // Display name: first profile-link anchor with non-empty visible text.
    // Excludes /status/ (the visit/share link) and /hashtag/ (links in tweet body).
    const profileLinks = Array.from(article.querySelectorAll('a')) as HTMLAnchorElement[];
    let displayName = '';
    for (const a of profileLinks) {
      const href = a.getAttribute('href') ?? '';
      if (!/\/\/(twitter|x)\.com\//.test(href)) continue;
      if (/\/status\//.test(href)) continue;
      if (/\/hashtag\//.test(href)) continue;
      if (/\/intent\//.test(href)) continue;
      const t = (a.textContent ?? '').trim();
      if (t.length > 0) { displayName = t; break; }
    }
    // Fallback display name when -onlyvideo mode strips the byline.
    if (!displayName && handle) displayName = handle;

    // Tweet text HTML — copy innerHTML. For long tweets X appends a "Show more"
    // anchor whose href points to a signin redirect chain. Keep the anchor (so
    // the user can click through to the full tweet) but rewrite the href to
    // the canonical https://x.com/.../status/... URL. Also prepend a leading
    // space text node to the anchor — X's own DOM separates "Show more" from
    // the tweet body with a <span>&nbsp;</span> sibling, but the &nbsp;
    // collapses during sanitization (trim() drops U+00A0), so without an
    // explicit space the rendered text reads "challengeShow more".
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    let tweetTextHtml = '';
    if (tweetTextEl) {
      const clone = tweetTextEl.cloneNode(true) as Element;
      clone.querySelectorAll('[data-testid="tweet-text-show-more-link"]').forEach(showMore => {
        if (statusUrl) showMore.setAttribute('href', statusUrl);
        const ownerDoc = showMore.ownerDocument ?? document;
        showMore.parentNode?.insertBefore(ownerDoc.createTextNode(' '), showMore);
      });
      tweetTextHtml = clone.innerHTML;
    }

    // Date text: prefer the human-readable form ("2:26 PM · May 29, 2026").
    const time = article.querySelector('time[datetime]');
    const dateText = time?.textContent?.trim() ?? '';

    // Photos: <img> tags inside any link whose href contains /photo/. May
    // include duplicates if widgets.js renders multiple sizes; dedupe by URL.
    const photoSrcsRaw = (Array.from(article.querySelectorAll('a[href*="/photo/"] img')) as HTMLImageElement[])
      .map(img => img.getAttribute('src') ?? '')
      .filter(s => s.length > 0);
    const photoSrcs = Array.from(new Set(photoSrcsRaw));

    // Videos in the embed page render as <video> with a poster, OR (more
    // commonly) as a still poster image inside a link. Embed iframes typically
    // don't have <video> elements. Leave empty if neither is found.
    const videoEls = Array.from(article.querySelectorAll('video[poster]')) as HTMLVideoElement[];
    const videoInfos = videoEls.map(v => ({
      poster: v.getAttribute('poster') ?? '',
      duration: null as string | null,
      aspectPct: null as number | null,
    })).filter(v => v.poster);

    // Badges: when the verified-account svg is present, emit the same inline
    // SVG Tier 0 uses on twitter.com so the card matches visually. The SVG
    // path data is the standard X verified glyph.
    const isVerified = !!article.querySelector('[data-testid="icon-verified"]');
    const badgesHtml = isVerified
      ? '<svg class="tweet-badge-verified" viewBox="0 0 22 22" aria-label="Verified" width="16" height="16"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>'
      : '';

    return {
      tweetId,
      statusUrl,
      displayName,
      handle,
      badgesHtml,
      tweetTextHtml,
      photoSrcs,
      videoInfos,
      avatarSrc,
      dateText,
      source: 'iframe',
    };
  } catch {
    return null;
  }
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

/**
 * Fetch the first 512 KB of a video URL (enough for the first keyframe of
 * most H.264 MP4s) and return it as a data URI. Used by captureVideoFrames
 * in capture.ts to work around the cross-origin canvas SecurityError.
 */
async function handleFetchVideoBlob(src: string): Promise<BackgroundResponse> {
  try {
    if (!/^https:/i.test(src)) return { success: false, error: 'Unsupported scheme' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(src, {
        signal: controller.signal,
        headers: { Range: 'bytes=0-524287' },
      });
    } finally {
      clearTimeout(timer);
    }
    // 200 or 206 (partial content) both OK.
    if (!res.ok && res.status !== 206) return { success: false, error: `HTTP ${res.status}` };
    const blob = await res.blob();
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

async function handleGetClipCount(): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned');
    request.onerror = () => resolve({ success: false, error: 'IndexedDB open failed' });
    request.onupgradeneeded = () => { /* read-only probe; no schema changes */ };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips')) { db.close(); resolve({ success: true, data: { count: 0 } }); return; }
      try {
        const tx = db.transaction(['clips'], 'readonly');
        const countReq = tx.objectStore('clips').count();
        countReq.onsuccess = () => { db.close(); resolve({ success: true, data: { count: countReq.result } }); };
        countReq.onerror = () => { db.close(); resolve({ success: true, data: { count: 0 } }); };
      } catch { db.close(); resolve({ success: true, data: { count: 0 } }); }
    };
  });
}

async function handleGetClips(): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned');
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
        // readwrite so we can repair legacy rows that have no capture.id
        const tx = db.transaction(['clips'], 'readwrite');
        const store = tx.objectStore('clips');
        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
          const rows = (getAllReq.result as ClipRow[]) ?? [];
          const clips: ClipData[] = [];
          for (const row of rows) {
            try {
              const clip = JSON.parse(row.encrypted) as ClipData;
              // Repair rows that survived a buggy migration with no capture.id.
              if (!clip.capture.id) {
                const newId = crypto.randomUUID();
                clip.capture.id = newId;
                const repairedRow: ClipRow = { id: newId, encrypted: JSON.stringify(clip), timestamp: row.timestamp };
                try { if (row.id) store.delete(row.id); } catch { /* invalid key — nothing to delete */ }
                store.put(repairedRow);
              }
              // Strip large fields — sent on demand via GET_CLIP_BODY to stay under 64MiB limit.
              delete clip.capture.bodyHtml;
              delete clip.capture.thumbnail;
              clips.push(clip);
            } catch { /* skip malformed */ }
          }
          tx.oncomplete = () => {
            db.close();
            clips.sort((a, b) => b.capture.timestamp - a.capture.timestamp);
            resolve({ success: true, data: { clips } });
          };
          tx.onerror = () => {
            db.close();
            clips.sort((a, b) => b.capture.timestamp - a.capture.timestamp);
            resolve({ success: true, data: { clips } });
          };
        };
        getAllReq.onerror = () => { db.close(); resolve({ success: true, data: { clips: [] } }); };
      } catch {
        db.close();
        resolve({ success: true, data: { clips: [] } });
      }
    };
  });
}

async function handleGetClipBody(id: string): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned');
    request.onerror = () => resolve({ success: false, error: 'IndexedDB open failed' });
    request.onupgradeneeded = () => { /* read-only probe; no schema changes */ };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips')) {
        db.close();
        resolve({ success: false, error: 'No clips store' });
        return;
      }
      try {
        const tx = db.transaction(['clips'], 'readonly');
        const getReq = tx.objectStore('clips').get(id);
        getReq.onerror = () => { db.close(); resolve({ success: false, error: 'Read failed' }); };
        getReq.onsuccess = () => {
          db.close();
          const row = getReq.result as ClipRow | undefined;
          if (!row) { resolve({ success: false, error: 'Clip not found' }); return; }
          try {
            const clip = JSON.parse(row.encrypted) as ClipData;
            resolve({ success: true, data: { bodyHtml: clip.capture.bodyHtml, thumbnail: clip.capture.thumbnail } });
          } catch {
            resolve({ success: false, error: 'Parse failed' });
          }
        };
      } catch {
        db.close();
        resolve({ success: false, error: 'Transaction failed' });
      }
    };
  });
}

async function handleDeleteClips(ids: string[]): Promise<BackgroundResponse> {
  const validIds = ids.filter(Boolean);
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned');
    request.onerror = () => {
      void pushResyncToWebApp();
      resolve({ success: false, error: 'IndexedDB open failed' });
    };
    request.onupgradeneeded = () => { /* probe only */ };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips') || validIds.length === 0) {
        db.close();
        resolve({ success: true });
        return;
      }
      try {
        const tx = db.transaction(['clips'], 'readwrite');
        const store = tx.objectStore('clips');
        let pending = validIds.length;
        let failed = false;
        for (const id of validIds) {
          const req = store.delete(id);
          req.onerror = () => {
            if (!failed) { failed = true; db.close(); void pushResyncToWebApp(); resolve({ success: false, error: 'Delete failed' }); }
          };
          req.onsuccess = () => {
            pending--;
            if (pending === 0 && !failed) {
              db.close();
              log(LL.DEBUG, `background: deleted ${validIds.length} clip(s)`, validIds.join(', '));
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
    const request = indexedDB.open('discerned');
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
    // Strip large fields before pushing — bodyHtml/thumbnail are fetched on demand.
    const captureSlim: typeof data.capture = { ...data.capture };
    delete captureSlim.bodyHtml;
    delete captureSlim.thumbnail;
    void pushClipToWebApp({ capture: captureSlim, evaluation: data.evaluation, encrypted: '' });
    return { success: true, data: { storage: 'local' } };
  } catch (error) {
    log(LL.ERROR, 'Clip error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Clip failed' };
  }
}

async function handleCast(
  data: { capture: Capture; evaluation: Evaluation },
): Promise<BackgroundResponse> {
  try {
    const eventTemplate = buildCastTemplate(data.capture, data.evaluation);
    // NIP-07 kind-1: always sign via the discerned web app so the wallet only
    // ever approves discerned.online, not each site the overlay is used on.
    // The web app signs silently (no modal) — window.nostr.signEvent is called
    // automatically when DISCERNED_BRIDGE_PENDING_SIGN arrives.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signedEvent: any = currentAuthState.type === 'pro'
      ? await signEventViaWebApp(eventTemplate)
      : await signEvent(eventTemplate);
    const publishResult = await publishWithMinimum(signedEvent);

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

function isDiscernedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('https://discerned.online/') || url.startsWith('http://localhost:3000/');
}

function rememberSigningTab(tabId: number, isOurs: boolean): void {
  signingTabId = tabId;
  signingTabIsOurs = isOurs;
  chrome.storage.session.set({ signingTabId: tabId, signingTabIsOurs: isOurs }).catch(() => {});
}

function forgetSigningTab(): void {
  signingTabId = null;
  signingTabIsOurs = false;
  chrome.storage.session.remove(['signingTabId', 'signingTabIsOurs']).catch(() => {});
}

// Close the signing tab only if we created it (a minimized window) — never a
// tab the user opened themselves. Called on logout, when it's no longer needed.
async function closeOwnSigningTab(): Promise<void> {
  if (signingTabId !== null && signingTabIsOurs) {
    try {
      await chrome.tabs.remove(signingTabId);
    } catch {
      // Already closed.
    }
  }
  forgetSigningTab();
}

// Poll a freshly opened tab until its content script answers PING (the
// SIGN_WITH_NIP07 listener is then live), or give up after ~5s.
async function waitForContentScript(tabId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' }) as { ok?: boolean } | undefined;
      if (res?.ok) return;
    } catch {
      // Content script not ready yet — retry.
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Signing tab did not become ready in time');
}

// Resolve a tab on the discerned origin to route NIP-07 signing through.
// Order: (1) reuse our cached signing tab if still valid; (2) reuse any discerned
// tab the user already has open, leaving it untouched; (3) open our own
// background tab on the lightweight /about route and wait for its content script.
//
// Case 3 opens a normal background TAB in the user's current window (not a
// separate chrome.windows.create window): NIP-07 wallets render their approval
// popup parented to the page's window, and a wallet popup parented to a
// programmatically-opened standalone window comes up blank/broken. A background
// tab in the user's existing window behaves like the (working) reuse case.
/**
 * Bring `tabId` to the foreground (active + its window focused). Best-effort:
 * silently swallows failures. Used to give wallet approval dialogs a focused
 * tab to render against — nos2x specifically renders a blank/stuck popup
 * when the sign request originates from a tab the OS doesn't consider active.
 */
async function focusTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Tab may have been closed mid-flight; caller will discover and retry.
  }
}

async function resolveSigningTab(focusSigningTab = false): Promise<number> {
  // (1) Cached signing tab.
  if (signingTabId !== null) {
    try {
      const tab = await chrome.tabs.get(signingTabId);
      if (tab && !tab.discarded && isDiscernedUrl(tab.url)) {
        if (focusSigningTab) await focusTab(signingTabId);
        return signingTabId;
      }
    } catch {
      // Tab was closed.
    }
    forgetSigningTab();
  }

  // (2) A discerned tab the user already has open — sign there silently.
  const existing = await chrome.tabs.query({ url: DISCERNED_URL_PATTERNS });
  const live = existing.find(t => t.id !== undefined && !t.discarded);
  if (live?.id !== undefined) {
    rememberSigningTab(live.id, false);
    if (focusSigningTab) await focusTab(live.id);
    return live.id;
  }

  // (3) Open our own tab in the user's current window. `focusSigningTab`
  // controls whether it's opened active. Some NIP-07 wallets (nos2x) leave a
  // blank/stuck approval dialog when the sign request comes from a non-active
  // tab — for user-initiated signs (casts) background is fine because those
  // normally hit case (2) reuse on later invocations.
  const base = await resolveBaseUrl();
  const tab = await chrome.tabs.create({ url: `${base}/about`, active: focusSigningTab });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('Failed to open signing tab');
  await waitForContentScript(tabId);
  rememberSigningTab(tabId, true);
  return tabId;
}

// Resolve the signing tab and ask it to sign via NIP-07. Returns the signer's
// response, or null if the tab was unreachable (caller should re-resolve once).
async function signWithSigningTab(
  template: Parameters<typeof finalizeEvent>[0],
  focusSigningTab = false,
): Promise<{ signed?: object; error?: string } | null> {
  const tabId = await resolveSigningTab(focusSigningTab);
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'SIGN_WITH_NIP07',
      event: template,
    }) as { signed?: object; error?: string };
  } catch {
    return null;
  }
}

// ── Web-app confirmation flow for NIP-07 kind-1 casts ───────────────────────
//
// Kind-1 casts always route through the web app so the wallet (Alby, nos2x)
// only ever needs to approve discerned.online once, not every arbitrary site
// the user opens the overlay on. The web app shows a Confirm button; the user
// click is the gesture window.nostr.signEvent needs to surface its prompt.

const PENDING_SIGN_TIMEOUT_MS = 120_000; // 2 min — user may not be at the keyboard

async function pushPendingSignToWebApp(id: string, event: Record<string, unknown>, tabId: number): Promise<void> {
  const msg: BackgroundMessage = { type: 'PUSH_PENDING_SIGN', id, event };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => { /* non-fatal */ });
}

/**
 * Sign a cast event by handing it off to the discerned web app for explicit
 * user confirmation. Opens (or focuses) a discerned tab, posts the pending
 * event through the bridge, and waits for the signed event to come back.
 * Throws on timeout or rejection.
 */
async function signEventViaWebApp(
  template: Parameters<typeof finalizeEvent>[0],
): Promise<Record<string, unknown>> {
  // Reuse an open discerned tab if there is one (so we don't yank focus
  // unexpectedly); otherwise open and focus a new one so the user can see
  // the confirm prompt.
  const existing = await chrome.tabs.query({ url: DISCERNED_URL_PATTERNS });
  const live = existing.find(t => t.id !== undefined && !t.discarded);
  let tabId: number;
  if (live?.id !== undefined) {
    tabId = live.id;
    await focusTab(tabId);
  } else {
    const base = await resolveBaseUrl();
    const tab = await chrome.tabs.create({ url: `${base}/`, active: true });
    if (tab.id === undefined) throw new Error('Failed to open discerned tab');
    tabId = tab.id;
    await waitForContentScript(tabId);
  }

  const id = `sign_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const signed = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSigns.delete(id);
      reject(new Error('User did not confirm the cast within 2 minutes'));
    }, PENDING_SIGN_TIMEOUT_MS);
    pendingSigns.set(id, { resolve, reject, timer });
    void pushPendingSignToWebApp(id, template as unknown as Record<string, unknown>, tabId);
  });
  return signed;
}

function resolvePendingSign(id: string, signed: Record<string, unknown>): void {
  const entry = pendingSigns.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSigns.delete(id);
  entry.resolve(signed);
}

function rejectPendingSign(id: string, error: string): void {
  const entry = pendingSigns.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSigns.delete(id);
  entry.reject(new Error(error));
}

// ── Kind-0 publish (dev-build manual trigger) ────────────────────────────────
//
// Triggered by the "Publish Kind Zero" button in the overlay settings (dev only).
// Signs and publishes a bare kind-0 profile event using the current tab as the
// NIP-07 signing context (for pro mode) so the wallet prompt appears on the
// page the user already has focused.

async function handlePublishKind0(senderTabId: number | undefined): Promise<BackgroundResponse> {
  try {
    const template = createProfileEvent({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let signed: any;
    if (currentAuthState.type === 'pro') {
      // Sign directly in the sender tab — the user already has it open and the
      // wallet's approval prompt will appear there. Do NOT route through
      // resolveSigningTab, which requires a discerned.online URL.
      if (senderTabId === undefined) throw new Error('No sender tab for NIP-07 signing');
      const response = await chrome.tabs.sendMessage(senderTabId, {
        type: 'SIGN_WITH_NIP07',
        event: template,
      }) as { signed?: object; error?: string } | null;
      if (!response) throw new Error('NIP-07 content script did not respond');
      if (response.error) throw new Error(response.error);
      signed = response.signed;
    } else {
      signed = await signEvent(template);
    }
    const result = await publishWithMinimum(signed);
    const health = getRelayHealth(result.results);
    if (result.success) {
      log(LL.NORMAL, '[kind0] published OK',
        { relays: `${health.healthy}/${health.total}` }, 'url:', 'background');
      return { success: true };
    }
    const ackErr = `Published but only ${health.healthy}/${health.total} relays ACKed`;
    log(LL.WARN, '[kind0] publish failed', { reason: ackErr }, 'url:', 'background');
    return { success: false, error: ackErr };
  } catch (err) {
    log(LL.WARN, '[kind0] publish error', { err }, 'url:', 'background');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function signEvent(
  template: Parameters<typeof finalizeEvent>[0],
  opts: { focusSigningTab?: boolean } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (currentAuthState.type === 'pro') {
    let response = await signWithSigningTab(template, opts.focusSigningTab);
    if (response === null) {
      // The cached signing tab was unreachable — drop it and resolve a fresh
      // one (reuse another discerned tab or open a new window).
      forgetSigningTab();
      response = await signWithSigningTab(template, opts.focusSigningTab);
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

  if (typeof cap.format === 'string') {
    // Already shape-migrated, but still repair missing id (can happen for rows
    // that went through an earlier buggy migration that assigned row.id = undefined).
    if (!cap.id) {
      const newRowId = row.id || crypto.randomUUID();
      cap.id = newRowId;
      row.id = newRowId;
      row.encrypted = JSON.stringify(payload);
    }
    return;
  }

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
  if (!cap.id) {
    const newRowId = row.id || crypto.randomUUID();
    cap.id = newRowId;
    row.id = newRowId;
  }
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
