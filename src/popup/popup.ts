// Role: Popup — UI controller
// Description: Renders auth state banner (guest/pro/nip46/nsec) and usage stats.
//              Provides "Join the Open Social Web" CTA for guest users and disconnect/unlock
//              actions for authenticated users. All user-data DOM writes use textContent (no innerHTML).
// Access: DOM (popup.html elements), chrome.runtime.sendMessage, chrome.storage.local, IndexedDB

import { initLogBridge } from '@/shared/logger';
import type { AuthState } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { npubEncode } from 'nostr-tools/nip19';

initLogBridge('popup');

document.addEventListener('DOMContentLoaded', async () => {
  await render();
  await loadUsageStats();
  document.getElementById('export-data')?.addEventListener('click', handleExport);
});

// ── Render ───────────────────────────────────────────────────────────────────

async function render() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    if (response.success) {
      renderAuthSection(response.data as AuthState);
    }
  } catch (err) {
    console.error('Failed to load auth state:', err);
  }
}

function renderAuthSection(state: AuthState) {
  const container = document.getElementById('auth-section');
  if (!container) return;

  // Clear previous content
  while (container.firstChild) container.removeChild(container.firstChild);

  switch (state.type) {
    case 'guest':
      container.appendChild(buildGuestBanner());
      break;
    case 'pro':
      container.appendChild(buildConnectedBanner('Connected via signing extension', null));
      break;
    case 'nip46':
      container.appendChild(buildConnectedBanner('Connected via email login', state.pubkey));
      break;
    case 'nsec':
      container.appendChild(buildNsecBanner(state));
      break;
  }
}

function buildGuestBanner(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'guest-banner';

  const title = document.createElement('div');
  title.className = 'guest-banner-title';
  title.textContent = 'Local Only';

  const desc = document.createElement('div');
  desc.className = 'guest-banner-desc';
  desc.textContent = 'Your evaluations are currently stored locally only. Connect an identity to broadcast publicly, build a verifiable reputation, and be part of the Open Social Web (Nostr).';

  const btn = document.createElement('button');
  btn.className = 'btn-join';
  btn.textContent = 'Connect an identity →';
  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/connect/connect.html') });
  });

  wrapper.appendChild(title);
  wrapper.appendChild(desc);
  wrapper.appendChild(btn);
  return wrapper;
}

function buildConnectedBanner(method: string, pubkey: string | null): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'connected-banner';

  const row = document.createElement('div');
  row.className = 'connected-row';

  const dot = document.createElement('div');
  dot.className = 'connected-dot';

  const info = document.createElement('div');
  info.className = 'connected-info';

  const label = document.createElement('div');
  label.className = 'connected-label';
  label.textContent = 'Status';

  const methodEl = document.createElement('div');
  methodEl.className = 'connected-method';
  methodEl.textContent = method;

  info.appendChild(label);
  info.appendChild(methodEl);

  const disconnectBtn = document.createElement('button');
  disconnectBtn.className = 'btn-disconnect';
  disconnectBtn.textContent = 'Disconnect';
  disconnectBtn.addEventListener('click', handleDisconnect);

  row.appendChild(dot);
  row.appendChild(info);
  row.appendChild(disconnectBtn);
  wrapper.appendChild(row);

  if (pubkey) {
    const idLabel = document.createElement('div');
    idLabel.className = 'profile-id-label';
    idLabel.textContent = 'Your profile ID';

    const idEl = document.createElement('div');
    idEl.className = 'profile-id';
    idEl.textContent = formatProfileId(pubkey);

    wrapper.appendChild(idLabel);
    wrapper.appendChild(idEl);
  }

  return wrapper;
}

function buildNsecBanner(state: AuthState & { type: 'nsec' }): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'connected-banner';

  const row = document.createElement('div');
  row.className = 'connected-row';

  const dot = document.createElement('div');
  dot.className = 'connected-dot';

  const info = document.createElement('div');
  info.className = 'connected-info';

  const label = document.createElement('div');
  label.className = 'connected-label';
  label.textContent = 'Status';

  const methodEl = document.createElement('div');
  methodEl.className = 'connected-method';
  methodEl.textContent = 'Connected with account key';

  info.appendChild(label);
  info.appendChild(methodEl);

  const disconnectBtn = document.createElement('button');
  disconnectBtn.className = 'btn-disconnect';
  disconnectBtn.textContent = 'Disconnect';
  disconnectBtn.addEventListener('click', handleDisconnect);

  row.appendChild(dot);
  row.appendChild(info);
  row.appendChild(disconnectBtn);
  wrapper.appendChild(row);

  const idLabel = document.createElement('div');
  idLabel.className = 'profile-id-label';
  idLabel.textContent = 'Your profile ID';

  const idEl = document.createElement('div');
  idEl.className = 'profile-id';
  idEl.textContent = formatProfileId(state.pubkey);

  wrapper.appendChild(idLabel);
  wrapper.appendChild(idEl);

  // PIN unlock section (shown when service worker was killed — key not in memory)
  // We don't know from the popup if the SW has the key; show unlock on demand
  const unlockSection = buildPinUnlock();
  wrapper.appendChild(unlockSection);

  return wrapper;
}

function buildPinUnlock(): HTMLElement {
  const container = document.createElement('div');
  container.id = 'pin-unlock-section';

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.style.cssText = 'font-size:0.75rem;color:#666;cursor:pointer;margin-top:8px;';
  summary.textContent = 'Unlock account key';

  const inner = document.createElement('div');
  inner.className = 'pin-unlock';

  const pinInput = document.createElement('input');
  pinInput.type = 'password';
  pinInput.placeholder = 'Enter your PIN';
  pinInput.id = 'popup-pin-input';

  const unlockBtn = document.createElement('button');
  unlockBtn.className = 'btn-unlock';
  unlockBtn.textContent = 'Unlock';

  const errorEl = document.createElement('div');
  errorEl.className = 'pin-error';
  errorEl.id = 'popup-pin-error';

  unlockBtn.addEventListener('click', async () => {
    const pin = pinInput.value;
    if (!pin) return;
    unlockBtn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'UNLOCK_NSEC', pin });
    unlockBtn.disabled = false;
    if (res.success) {
      details.open = false;
      errorEl.textContent = '';
    } else {
      errorEl.textContent = 'Incorrect PIN. Please try again.';
    }
  });

  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlockBtn.click();
  });

  inner.appendChild(pinInput);
  inner.appendChild(unlockBtn);
  details.appendChild(summary);
  details.appendChild(inner);
  details.appendChild(errorEl);
  container.appendChild(details);
  return container;
}

function formatProfileId(pubkey: string): string {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 16)}…${npub.slice(-8)}`;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function handleDisconnect() {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT_AUTH' });
  await render();
}

// ── Usage stats ──────────────────────────────────────────────────────────────

async function loadUsageStats() {
  try {
    const [clipCount, castStored] = await Promise.all([
      getGuestClipCount(),
      chrome.storage.local.get(STORAGE_KEYS.CAST_COUNT),
    ]);
    const clipCountEl = document.getElementById('clip-count');
    if (clipCountEl) clipCountEl.textContent = clipCount.toString();
    const castCountEl = document.getElementById('cast-count');
    if (castCountEl) castCountEl.textContent = ((castStored[STORAGE_KEYS.CAST_COUNT] as number | undefined) ?? 0).toString();
  } catch (err) {
    console.error('Failed to load usage stats:', err);
  }
}

function getGuestClipCount(): Promise<number> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned', 2);
    request.onerror = () => resolve(0);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips')) { db.close(); resolve(0); return; }
      const tx = db.transaction(['clips'], 'readonly');
      const countReq = tx.objectStore('clips').count();
      countReq.onsuccess = () => { db.close(); resolve(countReq.result); };
      countReq.onerror = () => { db.close(); resolve(0); };
    };
    request.onupgradeneeded = () => resolve(0);
  });
}

// ── Export ───────────────────────────────────────────────────────────────────

async function handleExport() {
  try {
    const clips = await getAllGuestClips();
    if (clips.length === 0) { alert('No data to export'); return; }
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(clips, null, 2));
    const link = document.createElement('a');
    link.href = dataUri;
    link.download = `discerned-export-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error('Export error:', err);
  }
}

function getAllGuestClips(): Promise<unknown[]> {
  return new Promise((resolve) => {
    const request = indexedDB.open('discerned', 2);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('clips')) { db.close(); resolve([]); return; }
      const tx = db.transaction(['clips'], 'readonly');
      const getAllReq = tx.objectStore('clips').getAll();
      getAllReq.onsuccess = () => { db.close(); resolve(getAllReq.result); };
      getAllReq.onerror = () => { db.close(); resolve([]); };
    };
    request.onupgradeneeded = () => resolve([]);
  });
}
