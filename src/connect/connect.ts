// Role: Connect Tab — identity sign-up controller
// Description: Handles all three Nostr identity connection methods on the connect page:
//              NIP-07 extension detection, NIP-46 remote signer (bunker://), and nsec import.
//              On successful connection, shows a confirmation and prompts the user to close the tab.
// Access: chrome.runtime.sendMessage (background messages only), window.close

import { initLogBridge } from '@/shared/logger';
import type { AuthState } from '@/shared/types';

initLogBridge('onboarding');

document.addEventListener('DOMContentLoaded', async () => {
  await checkExistingAuth();

  document.getElementById('btn-detect-nip07')?.addEventListener('click', handleDetectNip07);
  document.getElementById('btn-connect-nip46')?.addEventListener('click', handleConnectNip46);
  document.getElementById('btn-save-nsec')?.addEventListener('click', handleSaveNsec);
});

// ── Auth check on load ────────────────────────────────────────────────────────

async function checkExistingAuth(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    if (res?.success) {
      const state = res.data as AuthState;
      if (state.type !== 'guest') {
        showAlreadyConnected(state);
      }
    }
  } catch {
    // Service worker may not be running yet — ignore, user can still connect.
  }
}

function showAlreadyConnected(state: AuthState): void {
  const banner = document.getElementById('already-connected');
  const title  = document.getElementById('connected-title');
  const desc   = document.getElementById('connected-desc');
  if (!banner || !title || !desc) return;

  const methodLabel =
    state.type === 'pro'    ? 'browser wallet (NIP-07)' :
    state.type === 'nip46'  ? 'remote signer'           :
    state.type === 'nsec'   ? 'account key'             : '';

  title.textContent = `Already connected via ${methodLabel}`;
  desc.textContent  = 'You\'re all set. You can close this tab and start evaluating.';
  banner.style.display = 'block';
}

// ── NIP-07 detection ──────────────────────────────────────────────────────────

async function handleDetectNip07(): Promise<void> {
  const status = document.getElementById('nip07-status');
  const btn = document.getElementById('btn-detect-nip07') as HTMLButtonElement | null;

  setStatus(status, 'Checking…', 'spin');
  if (btn) btn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    if (res?.success && (res.data as AuthState).type === 'pro') {
      setStatus(status, '✓ Extension detected — you\'re connected!', 'ok');
      showAlreadyConnected(res.data as AuthState);
    } else {
      setStatus(
        status,
        'No extension found yet. Install Alby or nos2x, then browse any page — Discerned will detect it automatically.',
        'info',
      );
    }
  } catch {
    setStatus(status, 'Could not check — try again.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── NIP-46 remote signer ──────────────────────────────────────────────────────

async function handleConnectNip46(): Promise<void> {
  const input  = document.getElementById('bunker-input')    as HTMLTextAreaElement | null;
  const status = document.getElementById('nip46-status');
  const btn    = document.getElementById('btn-connect-nip46') as HTMLButtonElement | null;

  const bunkerUri = input?.value.trim() ?? '';
  if (!bunkerUri) {
    setStatus(status, 'Paste your bunker:// link first.', 'error');
    return;
  }

  setStatus(status, 'Connecting…', 'spin');
  if (btn) btn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'CONNECT_NIP46', bunkerUri });
    if (res?.success) {
      setStatus(status, '✓ Connected!', 'ok');
      const authRes = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
      if (authRes?.success) showAlreadyConnected(authRes.data as AuthState);
    } else {
      setStatus(status, res?.error ?? 'Connection failed. Check the link and try again.', 'error');
    }
  } catch {
    setStatus(status, 'Connection failed — try again.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── nsec import ───────────────────────────────────────────────────────────────

async function handleSaveNsec(): Promise<void> {
  const nsecEl       = document.getElementById('nsec-input')   as HTMLTextAreaElement | null;
  const pinEl        = document.getElementById('pin-input')    as HTMLInputElement   | null;
  const pinConfirmEl = document.getElementById('pin-confirm')  as HTMLInputElement   | null;
  const status = document.getElementById('nsec-status');
  const btn    = document.getElementById('btn-save-nsec') as HTMLButtonElement | null;

  const rawNsec    = nsecEl?.value.trim()    ?? '';
  const pin        = pinEl?.value            ?? '';
  const pinConfirm = pinConfirmEl?.value     ?? '';

  if (!rawNsec.startsWith('nsec1')) {
    setStatus(status, 'Invalid key — must start with nsec1…', 'error');
    return;
  }
  if (pin.length < 6) {
    setStatus(status, 'PIN must be at least 6 characters.', 'error');
    return;
  }
  if (pin !== pinConfirm) {
    setStatus(status, 'PINs don\'t match.', 'error');
    return;
  }

  setStatus(status, 'Encrypting…', 'spin');
  if (btn) btn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'CONNECT_NSEC', rawNsec, pin });
    if (res?.success) {
      setStatus(status, '✓ Saved!', 'ok');
      const authRes = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
      if (authRes?.success) showAlreadyConnected(authRes.data as AuthState);
    } else {
      setStatus(status, res?.error ?? 'Failed to save key. Please try again.', 'error');
    }
  } catch {
    setStatus(status, 'Failed — try again.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(el: HTMLElement | null, text: string, kind: 'error' | 'ok' | 'info' | 'spin'): void {
  if (!el) return;
  el.className = `status-line ${kind}`;
  if (kind === 'spin') {
    // Inline spinner — safe because we control both parts and text is not user-supplied
    const spinner = document.createElement('span');
    spinner.className = 'spinner-inline';
    const label = document.createTextNode(text);
    el.replaceChildren(spinner, label);
  } else {
    el.textContent = text;
  }
}
