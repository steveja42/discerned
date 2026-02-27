// Role: Content Script — entry point
// Description: Listens for ACTIVATE_DISCERNED (show overlay) and SIGN_WITH_NIP07 (delegate
//              signing to this context) messages from the background. Coordinates capture,
//              overlay rendering, and forwards Clip/Cast payloads back to the background.
// Access: DOM (document.body), chrome.runtime.onMessage/sendMessage

import { captureContext, isCapturablePage } from './capture';
import { DiscernedOverlay } from './overlay';
import { detectAuthState, signWithNIP07 } from '@/shared/nostr/auth';
import type { AuthState, BackgroundMessage, Evaluation } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { initLogBridge, relayLog } from '@/shared/logger';

initLogBridge('content');

let currentOverlay: DiscernedOverlay | null = null;
let cachedAuthState: AuthState = { type: 'guest' };

/**
 * Listen for messages from the background script
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ACTIVATE_DISCERNED') {
    handleActivation();
    sendResponse({ success: true });
  } else if (message.type === 'SIGN_WITH_NIP07') {
    // Background delegates NIP-07 signing here because the service worker
    // has no DOM access for script injection.
    signWithNIP07(message.event as Parameters<typeof signWithNIP07>[0])
      .then(signed => sendResponse({ signed }))
      .catch((err: unknown) => sendResponse({
        error: err instanceof Error ? err.message : 'NIP-07 signing failed',
      }));
    return true; // keep channel open for async response
  } else if (message.type === 'LOG_RELAY') {
    // Re-emit relayed logs from popup/background using pre-override originals so they
    // appear in VSCode's page-context debug session without picking up a [content] prefix.
    relayLog(message.level, message.source, message.serialized);
  }
  return true;
});

/**
 * Detect NIP-07 on page load and notify the background so it can update
 * currentAuthState. Runs once per content-script lifecycle.
 */
detectAuthState().then(state => {
  cachedAuthState = state;
  if (state.type === 'pro') {
    chrome.runtime.sendMessage({ type: 'NIP07_DETECTED', hasNIP07: true }).catch(() => {
      // Background may not be ready on the very first load — that's fine.
    });
  }
}).catch(() => {
  // Detection failure is non-fatal; extension stays in guest mode.
});

/**
 * Main activation handler
 */
async function handleActivation() {
  // Check if page is capturable
  if (!isCapturablePage()) {
    console.warn('Discerned: Cannot capture on this page');
    return;
  }

  // Close existing overlay if present
  if (currentOverlay) {
    currentOverlay.hide();
  }

  // Capture current context
  const capture = captureContext();

  // Check if nudge has been dismissed by the user
  let nudgeDismissed = false;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED);
    nudgeDismissed = !!stored[STORAGE_KEYS.OVERLAY_NUDGE_DISMISSED];
  } catch {
    // Non-fatal; default to showing nudge
  }

  // Get fresh auth state from background — avoids stale cache after the user
  // connects an identity via the overlay without reloading the page.
  let freshAuthState: AuthState = cachedAuthState;
  try {
    const authRes = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    if (authRes?.success && authRes.data) {
      freshAuthState = authRes.data as AuthState;
      cachedAuthState = freshAuthState; // keep cache in sync
    }
  } catch {
    // Non-fatal; fall back to cached state
  }

  // Create and show overlay
  currentOverlay = new DiscernedOverlay();
  document.body.appendChild(currentOverlay);

  currentOverlay.show(capture, {
    onClip: (evaluation: Evaluation) => handleClip(capture, evaluation),
    onCast: (evaluation: Evaluation) => handleCast(capture, evaluation),
  }, freshAuthState, nudgeDismissed);
}

/**
 * Send a message to the background service worker with a timeout guard.
 * In Chrome MV3, chrome.runtime.sendMessage can hang indefinitely when the
 * service worker is slow to wake after being killed. The Promise never rejects —
 * it simply never resolves.
 *
 * CAST uses 30 s: relay-manager's per-relay timeout is 10 s, so the outer guard
 * must be larger to avoid racing the relay ACK wait. CLIP only needs ~1 s for
 * an IndexedDB write, but 30 s is a safe uniform limit.
 */
function sendToBackground(message: BackgroundMessage): Promise<{ success: boolean; error?: string; data?: unknown }> {
  return Promise.race([
    chrome.runtime.sendMessage(message) as Promise<{ success: boolean; error?: string; data?: unknown }>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Background service worker did not respond')), 30000)
    ),
  ]);
}

/**
 * Handle CLIP action - send to background for encryption and storage
 */
async function handleClip(capture: ReturnType<typeof captureContext>, evaluation: Evaluation) {
  try {
    const response = await sendToBackground({ type: 'CLIP', data: { capture, evaluation } });
    if (!response.success) {
      throw new Error(response.error);
    }
    console.log('Discerned: Successfully clipped');
  } catch (error) {
    console.error('Discerned: Clip failed', error);
    throw error;
  }
}

/**
 * Handle CAST action - send to background for signing and publishing
 */
async function handleCast(capture: ReturnType<typeof captureContext>, evaluation: Evaluation) {
  try {
    const response = await sendToBackground({ type: 'CAST', data: { capture, evaluation } });
    if (!response.success) {
      throw new Error(response.error);
    }
    console.log('Discerned: Successfully cast');
  } catch (error) {
    console.error('Discerned: Cast failed', error);
    showCastErrorToast(error instanceof Error ? error.message : 'Broadcast failed');
    throw error;
  }
}

/**
 * Show a fixed-position error toast when a cast fails.
 * The host element is positioned directly (not inside the shadow) so it sits cleanly
 * above the overlay backdrop without shadow-DOM stacking ambiguity.
 */
function showCastErrorToast(message: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;display:block;';
  host.attachShadow({ mode: 'closed' }).innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .toast {
        background: #1a1a1a; border: 1px solid #ef4444; border-radius: 8px;
        padding: 12px 16px; max-width: 300px; line-height: 1.4;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        animation: in .25s ease;
      }
      @keyframes in { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
      .title { font-size: 13px; font-weight: 600; color: #f87171; margin-bottom: 4px; }
      .body  { font-size: 12px; color: #888; }
    </style>
    <div class="toast">
      <div class="title">📡 Broadcast failed</div>
      <div class="body">${esc(message)}</div>
    </div>
  `;
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 5000);
}

// Log initialization
console.log('Discerned content script loaded');
