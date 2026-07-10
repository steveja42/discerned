// Role: Content Script — entry point
// Description: Listens for ACTIVATE_DISCERNED (show overlay) and SIGN_WITH_NIP07 (delegate
//              signing to this context) messages from the background. Coordinates capture,
//              overlay rendering, and forwards Clip/Cast payloads back to the background.
// Access: DOM (document.body), chrome.runtime.onMessage/sendMessage, chrome.storage.local

import { captureContext, isCapturablePage, hasSelection, __setTestHostOverride } from './capture';
import type { CaptureOptions } from './capture';
import { DiscernedOverlay } from './overlay';
import { detectAuthState, signWithNIP07 } from '@/shared/nostr/auth';
import type { AuthState, BackgroundMessage, Capture, ClipFormat, Evaluation, ResolvedTheme } from '@/shared/types';
import { STORAGE_KEYS, resolveThemePref, resolveEffectiveTheme } from '@/shared/types';
import { themeVarsBlock, prefersDark } from '@/shared/theme';
import { LL, log, relayLog } from '@/shared/logger';


let currentOverlay: DiscernedOverlay | null = null;
let cachedAuthState: AuthState = { type: 'guest' };

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const VALID_FORMATS: ClipFormat[] = [
  'selection', 'article', 'full-page', 'bookmark',
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isContextValid()) return false;
  if (message.type === 'ACTIVATE_DISCERNED') {
    handleActivation();
    sendResponse({ success: true });
  } else if (message.type === 'PING') {
    // Readiness probe — background uses this to confirm the SIGN_WITH_NIP07
    // listener is live in a freshly opened signing tab before sending an event.
    sendResponse({ ok: true });
  } else if (message.type === 'SIGN_WITH_NIP07') {
    signWithNIP07(message.event as Parameters<typeof signWithNIP07>[0])
      .then(signed => sendResponse({ signed }))
      .catch((err: unknown) => sendResponse({
        error: err instanceof Error ? err.message : 'NIP-07 signing failed',
      }));
    return true; // keep channel open for async response
  } else if (message.type === 'LOG_RELAY') {
    relayLog(message.level, message.source, message.serialized);
  } else if (message.type === 'SW_STARTED') {
    // SW was restarted — re-register so background can relay logs to this tab.
    chrome.runtime.sendMessage({ type: 'REGISTER_LOG_TAB' }).catch(() => {});
  }
  return true;
});

/**
 * Detect NIP-07 wallet presence on page load and notify the background.
 * Does NOT read the pubkey here — pubkey acquisition happens via the web app
 * Sign In flow (discerned.online only). Runs once per content-script lifecycle.
 */
detectAuthState().then(state => {
  cachedAuthState = state;
  if (state.type !== 'pro' || !isContextValid()) return;
  chrome.runtime.sendMessage({
    type: 'NIP07_DETECTED',
    hasNIP07: true,
  }).catch(() => {
    // Background may not be ready on the very first load — that's fine.
  });
}).catch(() => {
  // Detection failure is non-fatal; extension stays in guest mode.
});

/**
 * Decide which clip format to default to:
 *   1. Selection present → 'selection'
 *   2. Else last-used (if valid, and not 'selection') → that
 *   3. Else 'article'
 *
 * 'selection' is excluded from the last-used fallback: if the previous clip was a
 * selection and there is no current selection, defaulting back to 'selection' is
 * useless (nothing to capture). 'article' is the sensible fallback in that case.
 */
async function pickInitialFormat(selectionPresent: boolean): Promise<ClipFormat> {
  if (selectionPresent) return 'selection';
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.LAST_FORMAT);
    const last = stored[STORAGE_KEYS.LAST_FORMAT];
    if (typeof last === 'string' && last !== 'selection' && (VALID_FORMATS as string[]).includes(last)) {
      return last as ClipFormat;
    }
  } catch {
    // Non-fatal; fall through.
  }
  return 'article';
}

async function rememberFormat(format: ClipFormat): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_FORMAT]: format });
  } catch {
    // Non-fatal.
  }
}

async function handleActivation() {
  if (!isCapturablePage()) {
    log(LL.WARN, 'Discerned: Cannot capture on this page', 'url:', window.location.href);
    return;
  }

  // Toolbar-icon / context-menu acts as a toggle: if the overlay is currently in
  // the DOM, the second click closes it instead of recreating a fresh one.
  if (currentOverlay?.host.isConnected) {
    currentOverlay.hide();
    currentOverlay = null;
    return;
  }
  if (currentOverlay) {
    currentOverlay.hide();
    currentOverlay = null;
  }

  const selectionPresent = hasSelection();
  const initialFormat = await pickInitialFormat(selectionPresent);

  // Re-probe page for window.nostr on every activation. The MAIN-world bridge
  // (nip07-bridge.ts) is injected at document_start on <all_urls>, so it's
  // available here. The wallet may have appeared since the last activation,
  // or the user may have just disconnected and we need to re-transition
  // guest→pro before the GET_AUTH_STATE read below.
  let detected: AuthState = { type: 'guest' };
  try { detected = await detectAuthState(); } catch { /* non-fatal */ }
  if (detected.type === 'pro' && isContextValid()) {
    await chrome.runtime.sendMessage({
      type: 'NIP07_DETECTED',
      hasNIP07: true,
    }).catch(() => {});
  }

  let nudgeDismissed = false;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED);
    nudgeDismissed = !!stored[STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED];
  } catch {
    // Non-fatal; default to showing nudge.
  }

  let freshAuthState: AuthState = cachedAuthState;
  try {
    const authRes = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    if (authRes?.success && authRes.data) {
      freshAuthState = authRes.data as AuthState;
      cachedAuthState = freshAuthState;
    }
  } catch {
    // Non-fatal; fall back to cached state.
  }

  currentOverlay = new DiscernedOverlay();
  document.body.appendChild(currentOverlay.host);

  await currentOverlay.show({
    initialFormat,
    hasSelection: selectionPresent,
    onCapture: async (format: ClipFormat) => {
      let captureOpts: CaptureOptions = { smartArticleDetection: false, stripInlineStyles: false };
      try {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.SMART_ARTICLE_DETECTION,
          STORAGE_KEYS.STRIP_INLINE_STYLES,
        ]);
        captureOpts = {
          smartArticleDetection: !!(stored[STORAGE_KEYS.SMART_ARTICLE_DETECTION] as boolean | undefined),
          stripInlineStyles:     !!(stored[STORAGE_KEYS.STRIP_INLINE_STYLES]     as boolean | undefined),
        };
      } catch {
        // Non-fatal; use defaults.
      }
      log(LL.DEBUG, `Discerned: capture starting — format="${format}" smartArticleDetection=${captureOpts.smartArticleDetection} stripInlineStyles=${captureOpts.stripInlineStyles}`, 'url:', window.location.href);
      return captureContext(format, captureOpts);
    },
    onClip: async (capture: Capture, evaluation: Evaluation) => {
      await handleClip(capture, evaluation);
      void rememberFormat(capture.format);
    },
    onCast: async (capture: Capture, evaluation: Evaluation) => {
      const eventId = await handleCast(capture, evaluation);
      void rememberFormat(capture.format);
      return eventId;
    },
    authState: freshAuthState,
    nudgeDismissed,
  });
}

/**
 * Send a message to the background service worker with a timeout guard.
 * In Chrome MV3, chrome.runtime.sendMessage can hang indefinitely when the
 * service worker is slow to wake after being killed.
 *
 * CAST uses 150 s — the background's web-app confirm flow allows up to 2 min
 * for the user to click Confirm on first cast; this guard must exceed that so
 * the background can return a real error rather than "did not respond".
 * CLIP only needs ~1 s for an IndexedDB write but uses 30 s as a safe default.
 */
function sendToBackground(
  message: BackgroundMessage,
  timeoutMs = 30000,
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  if (!isContextValid()) return Promise.reject(new Error('Extension context invalidated'));
  return Promise.race([
    chrome.runtime.sendMessage(message) as Promise<{ success: boolean; error?: string; data?: unknown }>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Background service worker did not respond')), timeoutMs),
    ),
  ]);
}

async function handleClip(capture: Capture, evaluation: Evaluation) {
  try {
    const response = await sendToBackground({ type: 'CLIP', data: { capture, evaluation } });
    if (!response.success) throw new Error(response.error);
    log(LL.NORMAL, 'Discerned: Successfully clipped', 'url:', window.location.href);
  } catch (error) {
    log(LL.ERROR, 'Discerned: Clip failed', error, 'url:', window.location.href);
    throw error;
  }
}

async function handleCast(capture: Capture, evaluation: Evaluation): Promise<string | undefined> {
  try {
    const response = await sendToBackground({ type: 'CAST', data: { capture, evaluation } }, 150_000);
    if (!response.success) throw new Error(response.error);
    log(LL.NORMAL, 'Discerned: Successfully cast', 'url:', window.location.href);
    return (response.data as { eventId?: string } | undefined)?.eventId;
  } catch (error) {
    log(LL.ERROR, 'Discerned: Cast failed', error, 'url:', window.location.href);
    // PIN_REQUIRED means the stored key is locked — the overlay handles this with
    // an inline unlock prompt + auto-retry, so don't also surface a red toast.
    if (!(error instanceof Error && error.message === 'PIN_REQUIRED')) {
      void showCastErrorToast(error instanceof Error ? error.message : 'Broadcast failed');
    }
    throw error;
  }
}

/**
 * Show a fixed-position error toast when a cast fails.
 * The host element is positioned directly (not inside the shadow) so it sits cleanly
 * above the overlay panel without shadow-DOM stacking ambiguity.
 */
async function showCastErrorToast(message: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Resolve the active theme (provisional from OS, then reconciled with the stored
  // preference) so the toast matches the overlay's light/dark look.
  let theme: ResolvedTheme = resolveEffectiveTheme('system', prefersDark());
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.THEME);
    theme = resolveEffectiveTheme(resolveThemePref(stored[STORAGE_KEYS.THEME] as string | undefined), prefersDark());
  } catch { /* use provisional theme */ }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;display:block;';
  host.attachShadow({ mode: 'closed' }).innerHTML = `
    <style>
      :host {
${themeVarsBlock(theme)}
      }
      * { box-sizing: border-box; margin: 0; padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .toast {
        background: var(--p-card); border: 1px solid var(--p-danger); border-radius: 8px;
        padding: 12px 16px; max-width: 300px; line-height: 1.4;
        box-shadow: 0 4px 16px var(--p-cta-shadow);
        animation: in .25s ease;
      }
      @keyframes in { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
      .title { font-size: 13px; font-weight: 600; color: var(--p-danger); margin-bottom: 4px; }
      .body  { font-size: 12px; color: var(--p-ink-3); }
    </style>
    <div class="toast">
      <div class="title">📡 Broadcast failed</div>
      <div class="body">${esc(message)}</div>
    </div>
  `;
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 5000);
}

chrome.runtime.sendMessage({ type: 'REGISTER_LOG_TAB' }).catch(() => {});
log(LL.NORMAL, 'Discerned content script loaded', 'url:', window.location.href);

// When the browser restores this tab from the back/forward cache, the extension
// port is stale. Re-register so the background can relay logs again.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && isContextValid()) {
    chrome.runtime.sendMessage({ type: 'REGISTER_LOG_TAB' }).catch(() => {});
  }
});

// Dev-mode test bridge — Vite tree-shakes this when __DISCERNED_TEST_BUILD__
// is false (production builds). Lets Playwright drive captureContext() and the
// CLIP path without the overlay.
if (__DISCERNED_TEST_BUILD__) {
  window.addEventListener('message', async (e) => {
    // Note: in an extension content script, `window` is the isolated world's
    // wrapper — distinct from the page's `window` that's the message source.
    // We can't compare e.source === window. Rely on origin only.
    if (e.origin !== window.location.origin) return;
    const data = e.data as { type?: string; format?: ClipFormat; opts?: CaptureOptions; capture?: Capture; evaluation?: Evaluation; hostOverride?: string | null };
    if (!data || typeof data.type !== 'string') return;

    if (data.type === '__DISCERNED_TEST_CAPTURE') {
      try {
        // Optional: pretend the page is served from another host so site
        // taggers fire against 127.0.0.1 fixtures. Test-only; tree-shaken.
        __setTestHostOverride(typeof data.hostOverride === 'string' ? data.hostOverride : null);
        const cap = await captureContext(
          data.format ?? 'article',
          data.opts ?? { smartArticleDetection: false, stripInlineStyles: false },
        );
        __setTestHostOverride(null);
        window.postMessage(
          { type: '__DISCERNED_TEST_CAPTURE_RESULT', capture: cap },
          window.location.origin,
        );
      } catch (err) {
        __setTestHostOverride(null);
        window.postMessage(
          { type: '__DISCERNED_TEST_CAPTURE_RESULT', error: err instanceof Error ? err.message : String(err) },
          window.location.origin,
        );
      }
    } else if (data.type === '__DISCERNED_TEST_CLIP' && data.capture && data.evaluation) {
      try {
        const response = await sendToBackground({
          type: 'CLIP',
          data: { capture: data.capture, evaluation: data.evaluation },
        });
        window.postMessage(
          { type: '__DISCERNED_TEST_CLIP_RESULT', result: response },
          window.location.origin,
        );
      } catch (err) {
        window.postMessage(
          { type: '__DISCERNED_TEST_CLIP_RESULT', error: err instanceof Error ? err.message : String(err) },
          window.location.origin,
        );
      }
    }
  });
}
