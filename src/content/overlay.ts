// Role: Content Script — Evernote-style left-side clipper panel
// Description: Custom element (DiscernedOverlay) rendered inside a Shadow DOM. Fixed left-side
//              panel (380px wide, full-height) with five clip formats, a notes textarea, an
//              evaluation form, and an inline settings drawer (auth state + stats + export).
//              When format='article', a live on-page rectangle outlines the detected article
//              container via the highlighter module.
// Access: Shadow DOM (ShadowRoot); chrome.runtime.sendMessage for auth + stats; on-page DOM
//         (only for the article highlight rectangle, drawn into document.body).

import type { AuthState, Capture, ClipFormat, Evaluation, InterestLevel, EthicsLevel, Category } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { CAST_INLINE_BODY_MAX_CHARS } from '@/shared/nostr/events';
import { showArticleHighlight, hideArticleHighlight } from './highlighter';
import { npubEncode } from 'nostr-tools/nip19';

export interface OverlayShowOptions {
  initialFormat: ClipFormat;
  hasSelection: boolean;
  onCapture: (format: ClipFormat) => Promise<Capture>;
  onClip: (capture: Capture, evaluation: Evaluation) => Promise<void>;
  onCast: (capture: Capture, evaluation: Evaluation) => Promise<void>;
  authState: AuthState;
  nudgeDismissed: boolean;
}

type View = 'gate' | 'identity' | 'main' | 'settings';

export class DiscernedOverlay extends HTMLElement {
  private shadow: ShadowRoot;
  private opts: OverlayShowOptions | null = null;
  private capture: Capture | null = null;
  private format: ClipFormat = 'article';
  private hasSelection = false;
  private note = '';
  private customCategories: string[] = [];
  private authState: AuthState = { type: 'guest' };
  private view: View = 'main';
  private identityBackTarget: View = 'main';
  private captureGeneration = 0;
  private capturing = false;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'closed' });
  }

  /**
   * Stop pointer/keyboard events propagating from the panel into the host page so
   * sites with document-level event delegation don't intercept clicks inside us.
   */
  connectedCallback() {
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      this.addEventListener(type, stop);
    }
  }

  disconnectedCallback() {
    hideArticleHighlight();
  }

  async show(options: OverlayShowOptions): Promise<void> {
    this.opts = options;
    this.format = options.initialFormat;
    this.hasSelection = options.hasSelection;
    this.authState = options.authState;
    this.view = options.authState.type === 'guest' && !options.nudgeDismissed ? 'gate' : 'main';
    this.note = '';

    // Initial render so the user sees the panel chrome immediately, then capture asynchronously.
    this.render();
    if (this.view === 'main') {
      await this.refreshCapture();
    }
  }

  hide() {
    hideArticleHighlight();
    this.remove();
  }

  // ── Render dispatcher ──────────────────────────────────────────────────────

  private render() {
    switch (this.view) {
      case 'gate':     this.renderGate();     break;
      case 'identity': this.renderIdentity(); break;
      case 'settings': this.renderSettings(); break;
      case 'main':     this.renderMain();     break;
    }
    this.blockHostPageEvents();
    this.applyHighlightForCurrentFormat();
  }

  private blockHostPageEvents() {
    const root = this.shadow.querySelector('.discerned-root');
    if (!root) return;
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      root.addEventListener(type, stop);
    }
  }

  private applyHighlightForCurrentFormat() {
    if (this.view === 'main' && this.format === 'article') {
      showArticleHighlight();
    } else {
      hideArticleHighlight();
    }
  }

  // ── Gate (first-run for guests) ────────────────────────────────────────────

  private renderGate() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <h2>📡 Discerned</h2>
          <div class="header-actions">
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="panel-body gate-body">
          <div class="gate-icon">🌐</div>
          <p class="gate-title">Local Only</p>
          <p class="gate-desc">
            Your evaluations are stored locally. Connect an identity to broadcast publicly,
            build a verifiable reputation, and be part of the Open Social Web (Nostr).
          </p>
          <button class="btn btn-primary gate-btn" id="gate-connect">Connect an identity →</button>
          <button class="btn btn-ghost gate-btn" id="gate-clip-only">Store locally (no broadcast)</button>
        </div>
      </div>
    `;
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('gate-connect')?.addEventListener('click', () => {
      this.identityBackTarget = 'gate';
      this.view = 'identity';
      this.render();
    });
    this.shadow.getElementById('gate-clip-only')?.addEventListener('click', () => {
      this.view = 'main';
      this.render();
      void this.refreshCapture();
      chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_NUDGE' }).catch(() => {});
    });
  }

  // ── Identity (login) ───────────────────────────────────────────────────────

  private renderIdentity() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <button class="icon-btn back-btn" id="identity-back" aria-label="Back">←</button>
          <h2>Connect identity</h2>
          <div class="header-actions">
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="panel-body identity-body">
          <div class="identity-tabs">
            <button class="tab-btn active" id="tab-nip07" type="button">Extension</button>
            <button class="tab-btn" id="tab-nip46" type="button">Remote signer</button>
            <button class="tab-btn" id="tab-nsec"  type="button">Account key</button>
          </div>
          <div id="panel-nip07" class="identity-panel">
            <p class="panel-desc">
              Install
              <a href="https://chromewebstore.google.com/detail/alby-bitcoin-wallet-for-l/iokeahhehimjnekafflcihljlcjccdbe" target="_blank" rel="noopener noreferrer">Alby</a> or
              <a href="https://chrome.google.com/webstore/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp" target="_blank" rel="noopener noreferrer">nos2x</a>
              to sign with your Nostr identity. After installing, browse any page —
              Discerned detects it automatically. Or click below to check now.
            </p>
            <button class="btn btn-secondary" id="btn-detect-nip07" type="button">Detect extension now</button>
            <p class="identity-status" id="nip07-status"></p>
          </div>
          <div id="panel-nip46" class="identity-panel" style="display:none">
            <p class="panel-desc">
              Create a free account at
              <a href="https://nstart.me" target="_blank" rel="noopener noreferrer">nstart.me</a>,
              then paste your <code>bunker://</code> link below.
              Your private key never leaves the remote signer.
            </p>
            <textarea id="bunker-input" rows="3" placeholder="bunker://…"></textarea>
            <button class="btn btn-primary" id="btn-connect-nip46" type="button">Connect account</button>
            <p class="identity-status" id="nip46-status"></p>
          </div>
          <div id="panel-nsec" class="identity-panel" style="display:none">
            <p class="panel-warning">
              ⚠️ Your account key gives full access to your identity.
              It will be encrypted with a PIN before being saved — only you can unlock it.
            </p>
            <textarea id="nsec-input" rows="2" placeholder="nsec1…"></textarea>
            <input type="password" id="pin-input" placeholder="PIN (minimum 6 characters)" />
            <input type="password" id="pin-confirm" placeholder="Confirm PIN" />
            <button class="btn btn-primary" id="btn-save-nsec" type="button">Encrypt and save</button>
            <p class="identity-status" id="nsec-status"></p>
          </div>
        </div>
      </div>
    `;
    this.attachIdentityListeners();
  }

  private attachIdentityListeners() {
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('identity-back')?.addEventListener('click', () => {
      this.view = this.identityBackTarget;
      this.render();
      if (this.view === 'main' && !this.capture) void this.refreshCapture();
    });

    const tabDefs: Array<{ tabId: string; panelId: string }> = [
      { tabId: 'tab-nip07', panelId: 'panel-nip07' },
      { tabId: 'tab-nip46', panelId: 'panel-nip46' },
      { tabId: 'tab-nsec',  panelId: 'panel-nsec'  },
    ];
    tabDefs.forEach(({ tabId }, activeIndex) => {
      this.shadow.getElementById(tabId)?.addEventListener('click', () => {
        tabDefs.forEach(({ tabId: t, panelId: p }, i) => {
          const tabEl   = this.shadow.getElementById(t);
          const panelEl = this.shadow.getElementById(p) as HTMLElement | null;
          if (tabEl)   tabEl.classList.toggle('active', i === activeIndex);
          if (panelEl) panelEl.style.display = i === activeIndex ? '' : 'none';
        });
      });
    });

    this.shadow.getElementById('btn-detect-nip07')?.addEventListener('click', async () => {
      const status = this.shadow.getElementById('nip07-status');
      const btn    = this.shadow.getElementById('btn-detect-nip07') as HTMLButtonElement | null;
      this.setIdentityStatus(status, 'Checking…', 'spin');
      if (btn) btn.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
      if (btn) btn.disabled = false;
      if (res?.success && res.data?.type === 'pro') {
        this.setIdentityStatus(status, 'Extension detected — you\'re connected!', 'ok');
        this.authState = res.data;
        setTimeout(() => { this.view = 'main'; this.render(); void this.refreshCapture(); }, 900);
      } else {
        this.setIdentityStatus(status, 'No extension found. Install Alby or nos2x, visit any page, then try again.', 'error');
      }
    });

    this.shadow.getElementById('btn-connect-nip46')?.addEventListener('click', async () => {
      const input  = this.shadow.getElementById('bunker-input') as HTMLTextAreaElement | null;
      const status = this.shadow.getElementById('nip46-status');
      const btn    = this.shadow.getElementById('btn-connect-nip46') as HTMLButtonElement | null;
      const bunkerUri = input?.value.trim() ?? '';
      if (!bunkerUri) { this.setIdentityStatus(status, 'Paste your bunker:// link first.', 'error'); return; }
      this.setIdentityStatus(status, 'Connecting…', 'spin');
      if (btn) btn.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'CONNECT_NIP46', bunkerUri });
      if (btn) btn.disabled = false;
      if (res.success) {
        this.setIdentityStatus(status, 'Connected!', 'ok');
        const refreshed = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
        if (refreshed?.success && refreshed.data) this.authState = refreshed.data as AuthState;
        setTimeout(() => { this.view = 'main'; this.render(); void this.refreshCapture(); }, 900);
      } else {
        this.setIdentityStatus(status, res.error ?? 'Connection failed. Check the link and try again.', 'error');
      }
    });

    this.shadow.getElementById('btn-save-nsec')?.addEventListener('click', async () => {
      const nsecEl       = this.shadow.getElementById('nsec-input')  as HTMLTextAreaElement | null;
      const pinEl        = this.shadow.getElementById('pin-input')    as HTMLInputElement   | null;
      const pinConfirmEl = this.shadow.getElementById('pin-confirm')  as HTMLInputElement   | null;
      const status = this.shadow.getElementById('nsec-status');
      const btn    = this.shadow.getElementById('btn-save-nsec') as HTMLButtonElement | null;
      const rawNsec    = nsecEl?.value.trim() ?? '';
      const pin        = pinEl?.value ?? '';
      const pinConfirm = pinConfirmEl?.value ?? '';
      if (!rawNsec.startsWith('nsec1')) { this.setIdentityStatus(status, 'Invalid key — must start with nsec1…', 'error'); return; }
      if (pin.length < 6)               { this.setIdentityStatus(status, 'PIN must be at least 6 characters.', 'error'); return; }
      if (pin !== pinConfirm)           { this.setIdentityStatus(status, 'PINs don\'t match.', 'error'); return; }
      this.setIdentityStatus(status, 'Encrypting…', 'spin');
      if (btn) btn.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'CONNECT_NSEC', rawNsec, pin });
      if (btn) btn.disabled = false;
      if (res.success) {
        this.setIdentityStatus(status, 'Saved!', 'ok');
        const refreshed = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
        if (refreshed?.success && refreshed.data) this.authState = refreshed.data as AuthState;
        setTimeout(() => { this.view = 'main'; this.render(); void this.refreshCapture(); }, 900);
      } else {
        this.setIdentityStatus(status, res.error ?? 'Failed to save key. Please try again.', 'error');
      }
    });
  }

  private setIdentityStatus(el: Element | null, text: string, kind: 'error' | 'ok' | 'spin') {
    if (!el) return;
    el.className = `identity-status ${kind}`;
    if (kind === 'spin') el.innerHTML = `<span class="spinner-inline"></span>${this.escapeHtml(text)}`;
    else el.textContent = text;
  }

  // ── Settings drawer (auth status, stats, export) ───────────────────────────

  private renderSettings() {
    const ev = this.escapeHtml.bind(this);
    const auth = this.authState;
    const formatPubkey = (pk: string) => {
      try { const npub = npubEncode(pk); return `${npub.slice(0, 16)}…${npub.slice(-8)}`; } catch { return pk; }
    };

    let authBlock = '';
    if (auth.type === 'guest') {
      authBlock = `
        <div class="settings-card warning">
          <div class="card-title">Local Only</div>
          <div class="card-desc">Your evaluations are stored locally. Connect an identity to cast them publicly.</div>
          <button class="btn btn-primary" id="settings-connect">Connect an identity →</button>
        </div>
      `;
    } else if (auth.type === 'pro') {
      authBlock = `
        <div class="settings-card">
          <div class="card-row">
            <div>
              <div class="card-label">Status</div>
              <div class="card-value ok">Connected via signing extension</div>
            </div>
            <button class="link-btn" id="settings-disconnect">Disconnect</button>
          </div>
        </div>
      `;
    } else if (auth.type === 'nip46') {
      authBlock = `
        <div class="settings-card">
          <div class="card-row">
            <div>
              <div class="card-label">Status</div>
              <div class="card-value ok">Connected via email login</div>
            </div>
            <button class="link-btn" id="settings-disconnect">Disconnect</button>
          </div>
          <div class="profile-id">${ev(formatPubkey(auth.pubkey))}</div>
        </div>
      `;
    } else {
      authBlock = `
        <div class="settings-card">
          <div class="card-row">
            <div>
              <div class="card-label">Status</div>
              <div class="card-value ok">Connected with account key</div>
            </div>
            <button class="link-btn" id="settings-disconnect">Disconnect</button>
          </div>
          <div class="profile-id">${ev(formatPubkey(auth.pubkey))}</div>
          <details class="pin-unlock">
            <summary>Unlock account key</summary>
            <div class="pin-row">
              <input type="password" id="settings-pin" placeholder="Enter your PIN" />
              <button class="btn btn-secondary" id="settings-unlock">Unlock</button>
            </div>
            <div class="pin-error" id="settings-pin-error"></div>
          </details>
        </div>
      `;
    }

    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <button class="icon-btn back-btn" id="settings-back" aria-label="Back">←</button>
          <h2>Settings</h2>
          <div class="header-actions">
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="panel-body settings-body">
          ${authBlock}
          <div class="settings-card">
            <div class="card-label">Usage</div>
            <div class="usage-row"><span>🔒 Local clips</span><span class="usage-value" id="clip-count">—</span></div>
            <div class="usage-row"><span>📡 Public casts</span><span class="usage-value" id="cast-count">—</span></div>
          </div>
          <div class="settings-card">
            <button class="link-btn" id="settings-export">Export local clips as JSON</button>
          </div>
        </div>
      </div>
    `;

    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('settings-back')?.addEventListener('click', () => {
      this.view = 'main';
      this.render();
      if (!this.capture) void this.refreshCapture();
    });

    this.shadow.getElementById('settings-connect')?.addEventListener('click', () => {
      this.identityBackTarget = 'settings';
      this.view = 'identity';
      this.render();
    });

    this.shadow.getElementById('settings-disconnect')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DISCONNECT_AUTH' });
      const refreshed = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
      if (refreshed?.success && refreshed.data) this.authState = refreshed.data as AuthState;
      this.render();
    });

    this.shadow.getElementById('settings-unlock')?.addEventListener('click', async () => {
      const pinEl = this.shadow.getElementById('settings-pin') as HTMLInputElement | null;
      const errEl = this.shadow.getElementById('settings-pin-error');
      const pin = pinEl?.value ?? '';
      if (!pin) return;
      const res = await chrome.runtime.sendMessage({ type: 'UNLOCK_NSEC', pin });
      if (errEl) errEl.textContent = res.success ? '' : 'Incorrect PIN. Please try again.';
    });

    this.shadow.getElementById('settings-export')?.addEventListener('click', () => this.exportClips());

    void this.loadStats();
  }

  private async loadStats() {
    try {
      const cast = await chrome.storage.local.get(STORAGE_KEYS.CAST_COUNT);
      const castCount = (cast[STORAGE_KEYS.CAST_COUNT] as number | undefined) ?? 0;
      const castEl = this.shadow.getElementById('cast-count');
      if (castEl) castEl.textContent = String(castCount);

      const clipCount = await this.countLocalClips();
      const clipEl = this.shadow.getElementById('clip-count');
      if (clipEl) clipEl.textContent = String(clipCount);
    } catch (err) {
      console.warn('Failed to load stats', err);
    }
  }

  private countLocalClips(): Promise<number> {
    return new Promise((resolve) => {
      const req = indexedDB.open('discerned', 3);
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('clips')) { db.close(); resolve(0); return; }
        const tx = db.transaction(['clips'], 'readonly');
        const countReq = tx.objectStore('clips').count();
        countReq.onsuccess = () => { db.close(); resolve(countReq.result); };
        countReq.onerror = () => { db.close(); resolve(0); };
      };
      req.onupgradeneeded = () => resolve(0);
    });
  }

  private async exportClips() {
    const clips = await new Promise<unknown[]>((resolve) => {
      const req = indexedDB.open('discerned', 3);
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('clips')) { db.close(); resolve([]); return; }
        const tx = db.transaction(['clips'], 'readonly');
        const getAllReq = tx.objectStore('clips').getAll();
        getAllReq.onsuccess = () => { db.close(); resolve(getAllReq.result as unknown[]); };
        getAllReq.onerror = () => { db.close(); resolve([]); };
      };
      req.onupgradeneeded = () => resolve([]);
    });
    if (clips.length === 0) return;
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(clips, null, 2));
    const link = document.createElement('a');
    link.href = dataUri;
    link.download = `discerned-export-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ── Main view (clipper) ────────────────────────────────────────────────────

  private renderMain() {
    if (!this.opts) return;
    const isConnected = this.authState.type !== 'guest';

    const formats: Array<{ id: ClipFormat; label: string; icon: string; disabled?: boolean }> = [
      { id: 'selection',          label: 'Selection',  icon: '✂',  disabled: !this.hasSelection },
      { id: 'article',            label: 'Article',    icon: '📄' },
      { id: 'simplified-article', label: 'Simplified', icon: '📝' },
      { id: 'full-page',          label: 'Full page',  icon: '🗞' },
      { id: 'bookmark',           label: 'Bookmark',   icon: '🔖' },
    ];

    const chipHtml = formats.map(f => {
      const active = f.id === this.format ? ' active' : '';
      const dis = f.disabled ? ' disabled' : '';
      return `<button class="chip${active}" data-format="${f.id}"${dis ? ' disabled' : ''}><span class="chip-icon">${f.icon}</span>${this.escapeHtml(f.label)}</button>`;
    }).join('');

    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <h2>📡 Discerned</h2>
          <div class="header-actions">
            <button class="icon-btn" id="open-settings" aria-label="Settings" title="Settings">⚙</button>
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>

        <div class="panel-body main-body">
          <div class="format-row">${chipHtml}</div>

          <div class="preview-area" id="preview-area">${this.renderPreview()}</div>

          <div class="form-block">
            <label class="block-label" for="note-input">Notes</label>
            <textarea id="note-input" maxlength="2000" placeholder="Add a note or comment (optional)…">${this.escapeHtml(this.note)}</textarea>
          </div>

          <div class="form-block evaluation">
            <div class="form-group">
              <label for="interest">Interest</label>
              <select id="interest">
                <option value="Wise">Wise</option>
                <option value="Insightful">Insightful</option>
                <option value="Interesting">Interesting</option>
                <option value="Neutral" selected>Neutral</option>
                <option value="Noise">Noise</option>
              </select>
            </div>
            <div class="form-group">
              <label for="ethics">Ethics</label>
              <select id="ethics">
                <option value="Exemplary">Exemplary</option>
                <option value="Honest">Honest</option>
                <option value="Biased">Biased</option>
                <option value="Neutral" selected>Neutral</option>
                <option value="Misleading">Misleading</option>
                <option value="Malicious">Malicious</option>
              </select>
            </div>
            <div class="form-group">
              <label for="category">Category</label>
              <div class="combobox" id="category-combobox">
                <input type="text" id="category" value="General" autocomplete="off" spellcheck="false" />
                <button type="button" class="combobox-toggle" id="category-toggle" tabindex="-1">▾</button>
                <ul class="combobox-list" id="category-list" role="listbox">
                  <li data-value="General">General</li>
                  <li data-value="Tech">Tech</li>
                  <li data-value="Finance">Finance</li>
                  <li data-value="Health">Health</li>
                  <li data-value="Politics">Politics</li>
                  <li data-value="Philosophy">Philosophy</li>
                  <li data-value="Science">Science</li>
                  <li data-value="Culture">Culture</li>
                </ul>
              </div>
            </div>
          </div>

          <div class="cast-notice" id="cast-notice">${this.renderCastNotice(isConnected)}</div>
        </div>

        <footer class="panel-footer">
          <div class="footer-meta">
            <div class="nostr-status">
              <span class="status-dot${isConnected ? ' connected' : ''}"></span>
              <span class="status-text">${isConnected ? 'Connected to Nostr' : 'Local only'}</span>
              ${!isConnected ? '<button class="link-btn" id="nostr-signup-link">Connect →</button>' : ''}
            </div>
            <label class="keep-private-label">
              <input type="checkbox" id="keep-private"${!isConnected ? ' checked disabled' : ''} />
              <span>Keep private</span>
            </label>
          </div>
          <button class="btn btn-clip" id="clip" disabled>
            <span class="icon" id="clip-icon">${isConnected ? '📡' : '🔒'}</span>
            <span class="label">CLIP</span>
            <span class="sublabel" id="clip-sublabel">${isConnected ? 'Clip & broadcast' : 'Private storage'}</span>
          </button>
        </footer>

        <div class="loading" id="loading" style="display:none;">
          <div class="spinner"></div>
          <p id="loading-text">Saving…</p>
        </div>
      </div>
    `;

    this.attachMainListeners();
  }

  private attachMainListeners() {
    const isConnected = this.authState.type !== 'guest';

    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('open-settings')?.addEventListener('click', () => {
      this.view = 'settings';
      this.render();
    });

    this.shadow.querySelectorAll<HTMLButtonElement>('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const fmt = btn.dataset.format as ClipFormat | undefined;
        if (!fmt || btn.disabled) return;
        if (fmt === this.format) return;
        this.format = fmt;
        // Re-paint the chip row + preview area without losing user's evaluation/note state.
        this.shadow.querySelectorAll<HTMLButtonElement>('.chip').forEach(b => {
          b.classList.toggle('active', b.dataset.format === fmt);
        });
        this.applyHighlightForCurrentFormat();
        const noticeEl = this.shadow.getElementById('cast-notice');
        if (noticeEl) noticeEl.innerHTML = this.renderCastNotice(isConnected);
        void this.refreshCapture();
      });
    });

    const noteEl = this.shadow.getElementById('note-input') as HTMLTextAreaElement | null;
    noteEl?.addEventListener('input', () => {
      this.note = noteEl.value;
      const noticeEl = this.shadow.getElementById('cast-notice');
      if (noticeEl) noticeEl.innerHTML = this.renderCastNotice(isConnected);
    });

    const keepPrivateEl = this.shadow.getElementById('keep-private') as HTMLInputElement | null;
    const clipIconEl = this.shadow.getElementById('clip-icon');
    const clipSublabelEl = this.shadow.getElementById('clip-sublabel');
    const updateClipAppearance = () => {
      const keepPrivate = keepPrivateEl?.checked ?? true;
      const broadcastMode = !keepPrivate && isConnected;
      if (clipIconEl) clipIconEl.textContent = broadcastMode ? '📡' : '🔒';
      if (clipSublabelEl) clipSublabelEl.textContent = broadcastMode ? 'Clip & broadcast' : 'Private storage';
      const noticeEl = this.shadow.getElementById('cast-notice');
      if (noticeEl) noticeEl.innerHTML = this.renderCastNotice(isConnected);
    };
    keepPrivateEl?.addEventListener('change', updateClipAppearance);

    this.shadow.getElementById('nostr-signup-link')?.addEventListener('click', () => {
      this.identityBackTarget = 'main';
      this.view = 'identity';
      this.render();
    });

    this.shadow.getElementById('clip')?.addEventListener('click', () => this.handleClipAction());

    this.shadow.querySelectorAll('select').forEach(s => s.addEventListener('change', () => this.validateForm()));
    this.setupCategoryCombobox();
    this.validateForm();
  }

  private renderPreview(): string {
    if (this.capturing && !this.capture) {
      return `<div class="preview-loading"><div class="spinner-small"></div><span>Capturing…</span></div>`;
    }
    if (!this.capture) {
      return `<div class="preview-empty">No capture yet.</div>`;
    }
    const cap = this.capture;
    const ev = this.escapeHtml.bind(this);

    if (cap.format === 'selection') {
      const tmp = document.createElement('div');
      tmp.innerHTML = cap.selectionText ?? '';
      const text = tmp.textContent ?? '';
      const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
      return `
        <div class="preview-card preview-selection">
          <div class="preview-text">${ev(preview)}</div>
          <div class="preview-url">${ev(cap.url)}</div>
        </div>
      `;
    }

    if (cap.format === 'bookmark') {
      const thumb = cap.thumbnail ? `<img class="preview-thumb" src="${ev(cap.thumbnail)}" alt="">` : '';
      return `
        <div class="preview-card preview-bookmark">
          ${thumb}
          <div class="preview-title">${ev(cap.title)}</div>
          <div class="preview-url">${ev(cap.url)}</div>
        </div>
      `;
    }

    if (cap.format === 'full-page') {
      return `
        <div class="preview-card preview-full">
          <div class="preview-title">${ev(cap.title)}</div>
          <div class="preview-placeholder">📦 Full page capture stored locally</div>
        </div>
      `;
    }

    // article / simplified-article
    const text = cap.bodyText ?? '';
    const excerpt = text.length > 400 ? text.slice(0, 400) + '…' : text;
    const thumb = cap.format === 'article' && cap.thumbnail
      ? `<img class="preview-thumb" src="${ev(cap.thumbnail)}" alt="">`
      : '';
    const hint = cap.format === 'article'
      ? `<div class="preview-hint">Outlined on the page →</div>`
      : '';
    return `
      <div class="preview-card preview-article">
        ${thumb}
        <div class="preview-title">${ev(cap.title)}</div>
        <div class="preview-text">${ev(excerpt)}</div>
        ${hint}
      </div>
    `;
  }

  private renderCastNotice(isConnected: boolean): string {
    const cap = this.capture;
    if (!cap) return '';
    if (!isConnected) return '';
    const keepPrivateEl = this.shadow.getElementById('keep-private') as HTMLInputElement | null;
    const willBroadcast = keepPrivateEl ? !keepPrivateEl.checked : false;
    if (!willBroadcast) return '';

    const richFormats: ClipFormat[] = ['article', 'simplified-article', 'full-page'];
    if (!richFormats.includes(cap.format)) return '';

    const bodyText = cap.bodyText ?? '';
    if (bodyText.length === 0) return '';

    if (bodyText.length <= CAST_INLINE_BODY_MAX_CHARS) {
      const kb = (bodyText.length / 1024).toFixed(1);
      return `<span class="notice ok">Cast includes the full text — ~${this.escapeHtml(kb)} KB.</span>`;
    }
    return `<span class="notice warn">Long body — cast publishes title, URL, note &amp; ratings; full text stays local.</span>`;
  }

  private async refreshCapture() {
    if (!this.opts) return;
    const myGen = ++this.captureGeneration;
    this.capturing = true;
    const previewEl = this.shadow.getElementById('preview-area');
    if (previewEl) previewEl.innerHTML = this.renderPreview();

    let cap: Capture | null = null;
    try {
      cap = await this.opts.onCapture(this.format);
    } catch (err) {
      console.warn('Discerned: capture failed', err);
    }

    if (myGen !== this.captureGeneration) return; // a newer capture has started; discard
    this.capture = cap;
    this.capturing = false;
    const refreshedPreview = this.shadow.getElementById('preview-area');
    if (refreshedPreview) refreshedPreview.innerHTML = this.renderPreview();
    const noticeEl = this.shadow.getElementById('cast-notice');
    if (noticeEl) noticeEl.innerHTML = this.renderCastNotice(this.authState.type !== 'guest');
    this.validateForm();
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private setupCategoryCombobox() {
    const input  = this.shadow.getElementById('category')        as HTMLInputElement;
    const toggle = this.shadow.getElementById('category-toggle') as HTMLButtonElement;
    const list   = this.shadow.getElementById('category-list')   as HTMLUListElement;
    if (!input || !toggle || !list) return;

    // Re-add any previously entered custom categories so they survive a re-render.
    for (const c of this.customCategories) {
      const exists = Array.from(list.querySelectorAll('li')).some(li => li.dataset.value?.toLowerCase() === c.toLowerCase());
      if (!exists) {
        const li = document.createElement('li');
        li.dataset.value = c;
        li.textContent = c;
        li.classList.add('custom-entry');
        list.appendChild(li);
      }
    }

    const openList  = () => list.classList.add('open');
    const closeList = () => list.classList.remove('open');

    const selectValue = (value: string) => {
      input.value = value;
      closeList();
      this.validateForm();
    };

    const addCustomIfNew = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const alreadyExists = Array.from(list.querySelectorAll('li')).some(
        li => li.dataset.value?.toLowerCase() === trimmed.toLowerCase(),
      );
      if (!alreadyExists) {
        this.customCategories.push(trimmed);
        const li = document.createElement('li');
        li.dataset.value = trimmed;
        li.textContent = trimmed;
        li.classList.add('custom-entry');
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => selectValue(trimmed));
        list.appendChild(li);
      }
    };

    toggle.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('mousedown',   (e) => e.preventDefault());

    toggle.addEventListener('click', () => {
      if (list.classList.contains('open')) closeList();
      else { openList(); input.focus(); }
    });

    list.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => selectValue((li as HTMLLIElement).dataset.value ?? li.textContent ?? ''));
    });

    input.addEventListener('input', () => this.validateForm());
    input.addEventListener('blur', () => { addCustomIfNew(input.value); closeList(); });
  }

  private validateForm() {
    const interest = (this.shadow.getElementById('interest') as HTMLSelectElement | null)?.value;
    const ethics   = (this.shadow.getElementById('ethics')   as HTMLSelectElement | null)?.value;
    const category = (this.shadow.getElementById('category') as HTMLInputElement  | null)?.value.trim();
    const isValid = !!(interest && ethics && category) && !!this.capture && !this.capturing;
    const clipBtn = this.shadow.getElementById('clip') as HTMLButtonElement | null;
    if (clipBtn) clipBtn.disabled = !isValid;
  }

  private getEvaluation(): Evaluation {
    const interest = (this.shadow.getElementById('interest') as HTMLSelectElement).value as InterestLevel;
    const ethics   = (this.shadow.getElementById('ethics')   as HTMLSelectElement).value as EthicsLevel;
    const category = ((this.shadow.getElementById('category') as HTMLInputElement).value.trim() || 'General') as Category;
    return { interest, ethics, category };
  }

  private async handleClipAction() {
    if (!this.opts || !this.capture) return;
    const keepPrivateEl = this.shadow.getElementById('keep-private') as HTMLInputElement | null;
    const keepPrivate = keepPrivateEl?.checked ?? true;
    const isConnected = this.authState.type !== 'guest';
    const shouldBroadcast = !keepPrivate && isConnected;

    const evaluation = this.getEvaluation();
    const noteEl = this.shadow.getElementById('note-input') as HTMLTextAreaElement | null;
    const note = (noteEl?.value ?? '').trim();
    const captureWithNote: Capture = note ? { ...this.capture, note } : this.capture;

    this.showLoading('Saving…');
    try {
      await this.opts.onClip(captureWithNote, evaluation);
    } catch {
      this.showError('Failed to clip. Please try again.');
      return;
    }

    this.showSuccess(shouldBroadcast ? 'Clipped! 📡 Broadcasting…' : 'Clipped! 🔒');
    setTimeout(() => this.hide(), 1500);

    if (shouldBroadcast) {
      this.opts.onCast(captureWithNote, evaluation).catch((err: unknown) => {
        console.warn('Discerned: broadcast failed (clip already saved locally)',
          err instanceof Error ? err.message : err);
      });
    }
  }

  private showLoading(text: string) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    loading.style.display = 'flex';
    const p = loading.querySelector('p');
    if (p) p.textContent = text;
  }

  private showSuccess(message: string) {
    const loading = this.shadow.getElementById('loading');
    if (loading) loading.innerHTML = `<div class="success">✓ ${this.escapeHtml(message)}</div>`;
  }

  private showError(message: string) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    loading.innerHTML = `<div class="error">✗ ${this.escapeHtml(message)}</div>`;
    setTimeout(() => { loading.style.display = 'none'; }, 2500);
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private getStyles(): string {
    return `
      :host { display: block; }
      * { margin: 0; padding: 0; box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

      .discerned-root.panel {
        position: fixed; top: 0; left: 0; bottom: 0;
        width: 380px; max-width: 90vw;
        background: #1a1a1a; color: #e8e8e8;
        border-right: 1px solid #2a2a2a;
        box-shadow: 6px 0 24px rgba(0,0,0,0.45);
        z-index: 2147483647;
        display: flex; flex-direction: column;
        animation: slideIn 0.18s ease-out;
      }
      @keyframes slideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }

      .panel-header {
        flex: 0 0 auto;
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px;
        border-bottom: 1px solid #2a2a2a;
      }
      .panel-header h2 { color: #fff; font-size: 16px; font-weight: 600; flex: 1; }
      .header-actions { display: flex; gap: 4px; }

      .icon-btn {
        background: none; border: none; color: #888;
        cursor: pointer; width: 30px; height: 30px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 5px; font-size: 18px; transition: all 0.15s;
      }
      .icon-btn:hover { background: #2a2a2a; color: #fff; }
      .close-btn { font-size: 24px; }
      .back-btn { font-size: 18px; }

      .panel-body {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 14px 16px;
        display: flex; flex-direction: column; gap: 12px;
      }

      .panel-footer {
        flex: 0 0 auto;
        padding: 14px 16px;
        border-top: 1px solid #2a2a2a;
        display: flex; flex-direction: column; gap: 10px;
      }

      /* Format chips */
      .format-row {
        display: flex; flex-wrap: wrap; gap: 6px;
      }
      .chip {
        background: #252525; border: 1px solid #333;
        color: #ccc; font-size: 12px;
        padding: 6px 10px; border-radius: 999px;
        cursor: pointer; transition: all 0.15s;
        display: inline-flex; align-items: center; gap: 6px;
        font-family: inherit;
      }
      .chip:hover:not(:disabled) { border-color: #555; color: #fff; }
      .chip.active { background: #0c4a6e; border-color: #0ea5e9; color: #fff; }
      .chip:disabled { opacity: 0.4; cursor: not-allowed; }
      .chip-icon { font-size: 13px; }

      /* Preview area */
      .preview-area { display: block; }
      .preview-card {
        background: #232323; border-radius: 8px;
        border-left: 4px solid #0ea5e9;
        padding: 12px;
        display: flex; flex-direction: column; gap: 6px;
      }
      .preview-thumb {
        width: 100%; max-height: 120px;
        object-fit: cover; border-radius: 6px;
      }
      .preview-title { color: #fff; font-size: 14px; font-weight: 600; }
      .preview-text { color: #ccc; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
      .preview-url  { color: #888; font-size: 11px; word-break: break-all; }
      .preview-hint { color: #0ea5e9; font-size: 11px; }
      .preview-placeholder {
        background: #1a1a1a; border: 1px dashed #444;
        border-radius: 6px; padding: 14px;
        color: #888; font-size: 12px; text-align: center;
      }
      .preview-loading {
        display: flex; align-items: center; gap: 8px;
        color: #888; font-size: 13px; padding: 14px;
      }
      .preview-empty { color: #666; font-size: 12px; padding: 14px 0; }

      .form-block { display: flex; flex-direction: column; gap: 6px; }
      .block-label {
        color: #aaa; font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .form-block.evaluation { display: flex; flex-direction: row; gap: 8px; align-items: flex-start; }
      .form-group { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      label {
        color: #aaa; font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
      }

      textarea#note-input {
        width: 100%; min-height: 56px;
        background: #252525; border: 1px solid #333;
        border-radius: 6px; color: #e8e8e8;
        font-family: inherit; font-size: 13px;
        padding: 8px 10px; resize: vertical;
        outline: none; transition: border-color 0.15s;
      }
      textarea#note-input:focus { border-color: #0ea5e9; }

      select {
        background: #2a2a2a; border: 1px solid #444; color: #fff;
        padding: 8px; border-radius: 6px; font-size: 12px;
        width: 100%; font-family: inherit; cursor: pointer;
        transition: border-color 0.2s;
      }
      select:hover { border-color: #666; }
      select:focus { outline: none; border-color: #0ea5e9; box-shadow: 0 0 0 3px rgba(14,165,233,0.1); }

      /* Combobox */
      .combobox { position: relative; display: flex; }
      .combobox input[type="text"] {
        flex: 1; min-width: 0; background: #2a2a2a;
        border: 1px solid #444; border-right: none; color: #fff;
        padding: 8px; border-radius: 6px 0 0 6px;
        font-size: 12px; font-family: inherit; transition: border-color 0.2s;
      }
      .combobox-toggle {
        background: #2a2a2a; border: 1px solid #444; border-left: none;
        color: #888; padding: 0 8px; border-radius: 0 6px 6px 0;
        cursor: pointer; font-size: 11px; transition: border-color 0.2s;
      }
      .combobox:focus-within input[type="text"],
      .combobox:focus-within .combobox-toggle { border-color: #0ea5e9; }
      .combobox input[type="text"]:focus { outline: none; box-shadow: 0 0 0 3px rgba(14,165,233,0.1); }
      .combobox-toggle:hover { color: #fff; }

      .combobox-list {
        display: none; position: absolute; top: calc(100% + 3px); left: 0; right: 0;
        background: #222; border: 1px solid #555; border-radius: 6px;
        list-style: none; z-index: 9999;
        max-height: 180px; overflow-y: auto;
        box-shadow: 0 6px 18px rgba(0,0,0,0.5);
      }
      .combobox-list.open { display: block; }
      .combobox-list li { padding: 7px 10px; color: #e5e5e5; font-size: 12px; cursor: pointer; font-family: inherit; }
      .combobox-list li:hover { background: #0ea5e9; color: #fff; }
      .combobox-list li.custom-entry { color: #aaa; font-style: italic; }

      /* Cast notice */
      .cast-notice { min-height: 0; }
      .notice { font-size: 11px; line-height: 1.4; }
      .notice.ok   { color: #4ade80; }
      .notice.warn { color: #f0c040; }

      /* Footer meta */
      .footer-meta { display: flex; align-items: center; justify-content: space-between; }
      .nostr-status { display: flex; align-items: center; gap: 6px; }
      .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; flex-shrink: 0; }
      .status-dot.connected { background: #22c55e; }
      .status-text { font-size: 11px; color: #888; }
      .keep-private-label {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; color: #aaa; cursor: pointer; user-select: none;
      }
      .keep-private-label input[type="checkbox"] { width: 14px; height: 14px; accent-color: #0ea5e9; cursor: pointer; }
      .keep-private-label input[type="checkbox"]:disabled { cursor: not-allowed; }

      .link-btn {
        background: none; border: none; color: #0ea5e9;
        font-size: 11px; cursor: pointer; padding: 0 0 0 6px;
        text-decoration: underline; font-family: inherit; line-height: 1;
      }
      .link-btn:hover { color: #38bdf8; }

      /* Buttons */
      .btn {
        padding: 14px; border: none; border-radius: 8px;
        font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        font-family: inherit;
      }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
      .btn-secondary { background: #2a2a2a; color: #fff; border: 1px solid #444; }
      .btn-secondary:not(:disabled):hover { background: #333; }
      .btn-primary { background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #fff; }
      .btn-primary:not(:disabled):hover { background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); }
      .btn-clip {
        width: 100%;
        background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #fff;
      }
      .btn-clip:not(:disabled):hover { background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); }
      .btn-ghost { background: #252525; color: #888; border: 1px solid #333; }
      .btn-ghost:hover { background: #2a2a2a; color: #e8e8e8; }
      .btn .icon { font-size: 22px; }
      .btn .label { font-size: 13px; }
      .btn .sublabel { font-size: 11px; opacity: 0.7; font-weight: 400; }

      /* Gate */
      .gate-body {
        display: flex; flex-direction: column; align-items: center;
        text-align: center; padding: 28px 20px; gap: 14px;
      }
      .gate-icon { font-size: 40px; }
      .gate-title { font-size: 15px; font-weight: 600; color: #fff; }
      .gate-desc { font-size: 12px; color: #888; line-height: 1.6; max-width: 320px; }
      .gate-btn { width: 100%; max-width: 280px; }

      /* Identity */
      .identity-body { display: flex; flex-direction: column; gap: 14px; }
      .identity-tabs { display: flex; gap: 4px; border-bottom: 1px solid #333; }
      .tab-btn {
        background: none; border: none; border-bottom: 2px solid transparent;
        color: #888; font-size: 12px; font-weight: 600;
        padding: 7px 14px; cursor: pointer; margin-bottom: -1px;
        transition: color 0.15s, border-color 0.15s;
      }
      .tab-btn:hover { color: #e8e8e8; }
      .tab-btn.active { color: #0ea5e9; border-bottom-color: #0ea5e9; }
      .identity-panel { display: flex; flex-direction: column; gap: 10px; }
      .panel-desc { font-size: 12px; color: #888; line-height: 1.6; }
      .panel-desc a { color: #a78bfa; text-decoration: none; }
      .panel-desc a:hover { text-decoration: underline; }
      .panel-desc code { background: #252525; border: 1px solid #333; border-radius: 3px; padding: 1px 5px; font-size: 0.9em; color: #a78bfa; }
      .panel-warning { background: #2a1f00; border: 1px solid #6b4a00; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #f0c040; line-height: 1.5; }
      textarea {
        width: 100%; background: #252525; border: 1px solid #3a3a3a;
        border-radius: 6px; color: #e8e8e8;
        font-family: monospace; font-size: 12px;
        padding: 10px; resize: vertical; min-height: 56px;
        outline: none; transition: border-color 0.15s;
      }
      textarea:focus { border-color: #555; }
      input[type="password"] {
        width: 100%; background: #252525; border: 1px solid #3a3a3a;
        border-radius: 6px; color: #e8e8e8;
        font-size: 13px; padding: 10px;
        outline: none; transition: border-color 0.15s; font-family: inherit;
      }
      input[type="password"]:focus { border-color: #555; }
      .identity-status { font-size: 12px; min-height: 16px; display: flex; align-items: center; gap: 6px; }
      .identity-status.error { color: #f87171; }
      .identity-status.ok    { color: #4ade80; }
      .identity-status.spin  { color: #a78bfa; }
      .spinner-inline {
        display: inline-block; width: 12px; height: 12px; flex-shrink: 0;
        border: 2px solid #555; border-top-color: #a78bfa;
        border-radius: 50%; animation: spin 0.7s linear infinite;
      }

      /* Settings */
      .settings-body { gap: 12px; }
      .settings-card {
        background: #232323; border: 1px solid #2a2a2a;
        border-radius: 8px; padding: 12px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .settings-card.warning { background: #2a1f00; border-color: #6b4a00; }
      .card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .card-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
      .card-title { font-size: 13px; font-weight: 600; color: #f0c040; }
      .card-desc { font-size: 12px; color: #b89040; line-height: 1.5; }
      .card-value { font-size: 13px; color: #e8e8e8; }
      .card-value.ok { color: #4ade80; }
      .profile-id { font-size: 12px; color: #888; font-family: monospace; background: #1a1a1a; border-radius: 4px; padding: 6px 8px; word-break: break-all; }
      .usage-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #888; }
      .usage-value { color: #e8e8e8; font-weight: 600; }
      .pin-unlock summary { font-size: 12px; color: #888; cursor: pointer; }
      .pin-row { display: flex; gap: 6px; margin-top: 6px; }
      .pin-row input { flex: 1; background: #252525; border: 1px solid #3a3a3a; border-radius: 4px; color: #e8e8e8; font-size: 12px; padding: 6px 8px; outline: none; }
      .pin-row .btn { padding: 6px 10px; font-size: 12px; }
      .pin-error { font-size: 12px; color: #f87171; margin-top: 4px; }

      /* Loading overlay */
      .loading {
        position: absolute; inset: 0;
        background: rgba(26,26,26,0.95);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 14px;
      }
      .spinner {
        width: 44px; height: 44px;
        border: 4px solid #333; border-top-color: #0ea5e9;
        border-radius: 50%; animation: spin 0.8s linear infinite;
      }
      .spinner-small {
        width: 16px; height: 16px;
        border: 2px solid #333; border-top-color: #0ea5e9;
        border-radius: 50%; animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .loading p { color: #aaa; font-size: 14px; }
      .success { color: #22c55e; font-size: 18px; font-weight: 600; }
      .error   { color: #ef4444; font-size: 18px; font-weight: 600; }
    `;
  }
}

// Register the custom element (guard against double-registration on re-injection)
if (!customElements.get('discerned-overlay')) {
  customElements.define('discerned-overlay', DiscernedOverlay);
}
