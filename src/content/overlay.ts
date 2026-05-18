// Role: Content Script — Evernote-style left-side clipper panel
// Description: Custom element (DiscernedOverlay) rendered inside a Shadow DOM. Fixed left-side
//              panel (380px wide, full-height) with five clip formats, a notes textarea, an
//              evaluation form, and an inline settings drawer (auth state + stats + export).
//              When format='article', a live on-page rectangle outlines the detected article
//              container via the highlighter module.
// Access: Shadow DOM (ShadowRoot); chrome.runtime.sendMessage for auth + stats; on-page DOM
//         (only for the article highlight rectangle, drawn into document.body).

import type { AuthState, Capture, ClipFormat, Evaluation, InterestLevel, EthicsLevel, Category, PublishMode } from '@/shared/types';
import { STORAGE_KEYS } from '@/shared/types';
import { LL, log } from '@/shared/logger';
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

/** Formats that show a floating preview card to the right of the main panel. */
const PREVIEW_FORMATS: ClipFormat[] = ['selection', 'article', 'bookmark'];

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
  private publishMode: PublishMode = 'both';
  private interest: InterestLevel = 'Interesting';
  private ethics: EthicsLevel = 'Neutral';
  private category: Category = 'General';
  private previewHost: HTMLElement | null = null;
  private previewShadow: ShadowRoot | null = null;
  private outsideClickHandler: ((e: PointerEvent) => void) | null = null;

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
    this.outsideClickHandler = (e: PointerEvent) => {
      if (!e.composedPath().includes(this) && !this.previewHost?.contains(e.target as Node)) this.hide();
    };
    document.addEventListener('pointerdown', this.outsideClickHandler);
  }

  disconnectedCallback() {
    if (this.outsideClickHandler) {
      document.removeEventListener('pointerdown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    hideArticleHighlight();
    this.removePreview();
  }

  async show(options: OverlayShowOptions): Promise<void> {
    this.opts = options;
    this.format = options.initialFormat;
    this.hasSelection = options.hasSelection;
    this.authState = options.authState;
    this.view = options.authState.type === 'guest' && !options.nudgeDismissed ? 'gate' : 'main';
    this.note = '';

    // Initial render immediately so the user sees the panel chrome, then
    // load persisted evaluation defaults and re-render main (if needed).
    this.render();

    // Load persisted publish mode + evaluation defaults, then patch the main view.
    // Done after the first render so the panel appears instantly with no async delay.
    void (async () => {
      try {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.LAST_PUBLISH_MODE, STORAGE_KEYS.LAST_INTEREST,
          STORAGE_KEYS.LAST_ETHICS, STORAGE_KEYS.LAST_CATEGORY,
        ]);
        const validModes: PublishMode[] = ['cast', 'local', 'both'];
        const m = stored[STORAGE_KEYS.LAST_PUBLISH_MODE] as string | undefined;
        if (m && (validModes as string[]).includes(m)) this.publishMode = m as PublishMode;

        const validInterests: InterestLevel[] = ['Wise', 'Insightful', 'Interesting', 'Neutral', 'Noise'];
        const si = stored[STORAGE_KEYS.LAST_INTEREST] as string | undefined;
        if (si && (validInterests as string[]).includes(si)) this.interest = si as InterestLevel;

        const validEthics: EthicsLevel[] = ['Exemplary', 'Honest', 'Neutral', 'Misleading', 'Malicious'];
        const se = stored[STORAGE_KEYS.LAST_ETHICS] as string | undefined;
        if (se && (validEthics as string[]).includes(se)) this.ethics = se as EthicsLevel;

        const sc = stored[STORAGE_KEYS.LAST_CATEGORY] as string | undefined;
        if (sc?.trim()) this.category = sc.trim();
      } catch { /* non-fatal; use defaults */ }

      try {
        const catStored = await chrome.storage.local.get(STORAGE_KEYS.CATEGORIES);
        const persisted = (catStored[STORAGE_KEYS.CATEGORIES] as string[] | undefined) ?? [];
        this.customCategories = persisted.length > 0 ? persisted : this.customCategories;
      } catch { /* non-fatal; categories stay in-memory */ }

      if (this.authState.type === 'guest') this.publishMode = 'local';

      // Re-render main view to reflect loaded state (only if main view is active).
      if (this.view === 'main') this.render();
    })();

    if (this.view === 'main') {
      await this.refreshCapture();
    }
  }

  hide() {
    hideArticleHighlight();
    this.removePreview();
    this.remove();
  }

  private removePreview() {
    this.previewHost?.remove();
    this.previewHost = null;
    this.previewShadow = null;
  }

  private updatePreview() {
    const showPreview = PREVIEW_FORMATS.includes(this.format);
    if (!showPreview) {
      this.removePreview();
      return;
    }
    if (!this.previewHost) {
      this.previewHost = document.createElement('div');
      this.previewHost.style.cssText =
        'position:fixed;left:390px;top:50%;transform:translateY(-50%);' +
        'z-index:2147483646;display:block;max-width:320px;';
      this.previewShadow = this.previewHost.attachShadow({ mode: 'closed' });
      // Stop host-page event delegation from firing on preview interactions.
      // pointerdown is NOT stopped here — it's handled by the outside-click guard
      // (which already exempts previewHost), allowing text selection to work.
      for (const t of ['click', 'mousedown', 'mouseup', 'keydown', 'keyup']) {
        this.previewHost.addEventListener(t, (e) => e.stopPropagation());
      }
      document.body.appendChild(this.previewHost);
    }
    const shadow = this.previewShadow!;
    shadow.innerHTML = `
      <style>
        * { margin:0; padding:0; box-sizing:border-box;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        .preview-card {
          background:#1e1e1e; border:1px solid #333; border-left:4px solid #0ea5e9;
          border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:8px;
          box-shadow:4px 4px 20px rgba(0,0,0,0.5);
          animation:fadeIn .18s ease-out;
          user-select:text; cursor:text;
        }
        @keyframes fadeIn { from { opacity:0; transform:translateX(-6px); } to { opacity:1; transform:none; } }
        .preview-label {
          font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:#0ea5e9;
        }
        .preview-thumb {
          max-width:100%; max-height:120px; width:auto; height:auto; object-fit:contain; border-radius:5px; align-self:flex-start;
        }
        .preview-title { color:#fff; font-size:13px; font-weight:600; line-height:1.4; }
        .preview-text  { color:#bbb; font-size:12px; line-height:1.55; white-space:pre-wrap; }
        .preview-url   { color:#666; font-size:11px; word-break:break-all; }
        .preview-loading { display:flex; align-items:center; gap:8px; color:#888; font-size:12px; }
        .spinner {
          width:14px; height:14px; flex-shrink:0;
          border:2px solid #333; border-top-color:#0ea5e9;
          border-radius:50%; animation:spin .8s linear infinite;
        }
        @keyframes spin { to { transform:rotate(360deg); } }
      </style>
      ${this.renderPreviewContent()}
    `;
  }

  private renderPreviewContent(): string {
    if (this.capturing && !this.capture) {
      return `<div class="preview-card"><div class="preview-loading"><div class="spinner"></div><span>Capturing…</span></div></div>`;
    }
    const cap = this.capture;
    if (!cap) return `<div class="preview-card"><div class="preview-loading"><span>No capture yet.</span></div></div>`;
    const ev = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

    if (cap.format === 'selection') {
      const tmp = document.createElement('div');
      tmp.innerHTML = cap.selectionText ?? '';
      const text = tmp.textContent ?? '';
      const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
      return `
        <div class="preview-card">
          <div class="preview-label">Selection</div>
          <div class="preview-text">${ev(preview)}</div>
          <div class="preview-url">${ev(cap.url)}</div>
        </div>`;
    }

    if (cap.format === 'article') {
      const thumb = cap.thumbnail ? `<img class="preview-thumb" src="${ev(cap.thumbnail)}" alt="">` : '';
      const excerpt = cap.bodyText ? ev(cap.bodyText.slice(0, 300)) + '…' : '';
      return `
        <div class="preview-card">
          <div class="preview-label">Article</div>
          ${thumb}
          <div class="preview-title">${ev(cap.title)}</div>
          ${excerpt ? `<div class="preview-text">${excerpt}</div>` : ''}
          <div class="preview-url">${ev(cap.url)}</div>
        </div>`;
    }

    if (cap.format === 'bookmark') {
      const thumb = cap.thumbnail ? `<img class="preview-thumb" src="${ev(cap.thumbnail)}" alt="">` : '';
      return `
        <div class="preview-card">
          <div class="preview-label">Bookmark</div>
          ${thumb}
          <div class="preview-title">${ev(cap.title)}</div>
          <div class="preview-url">${ev(cap.url)}</div>
        </div>`;
    }

    return '';
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
            <button class="usage-row usage-row-link" id="open-library-btn"><span>🔒 Local clips</span><span class="usage-value" id="clip-count">—</span></button>
            <div class="usage-row"><span>📡 Public casts</span><span class="usage-value" id="cast-count">—</span></div>
          </div>
          <div class="settings-card">
            <div class="card-label">Capture</div>
            <label class="toggle-row">
              <input type="checkbox" id="opt-smart-article" />
              <span class="toggle-label">
                <span class="toggle-title">Smart article detection</span>
                <span class="toggle-desc">Skip broad article containers (feeds, pages with nested articles or nav) and use Readability instead.</span>
              </span>
            </label>
            <label class="toggle-row">
              <input type="checkbox" id="opt-strip-styles" />
              <span class="toggle-label">
                <span class="toggle-title">Strip inline styles</span>
                <span class="toggle-desc">Remove style= attributes from captured HTML so clips render with Reading Room styling only.</span>
              </span>
            </label>
          </div>
          <div class="settings-card">
            <button class="link-btn" id="settings-export">Export local clips as JSON</button>
          </div>
        </div>
      </div>
    `;

    this.shadow.getElementById('close')?.addEventListener('click', () => {
      this.view = 'main';
      this.render();
      if (!this.capture) void this.refreshCapture();
    });
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

    this.shadow.getElementById('open-library-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' }).catch(() => {});
      this.hide();
    });

    this.shadow.getElementById('settings-export')?.addEventListener('click', () => this.exportClips());

    void this.loadStats();
    void this.loadCaptureToggles();
  }

  private async loadCaptureToggles() {
    try {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.SMART_ARTICLE_DETECTION,
        STORAGE_KEYS.STRIP_INLINE_STYLES,
      ]);
      const smartEl = this.shadow.getElementById('opt-smart-article') as HTMLInputElement | null;
      const stripEl = this.shadow.getElementById('opt-strip-styles')  as HTMLInputElement | null;
      if (smartEl) smartEl.checked = !!(stored[STORAGE_KEYS.SMART_ARTICLE_DETECTION] as boolean | undefined);
      if (stripEl) stripEl.checked = !!(stored[STORAGE_KEYS.STRIP_INLINE_STYLES]     as boolean | undefined);

      smartEl?.addEventListener('change', () => {
        void chrome.storage.local.set({ [STORAGE_KEYS.SMART_ARTICLE_DETECTION]: smartEl.checked });
      });
      stripEl?.addEventListener('change', () => {
        void chrome.storage.local.set({ [STORAGE_KEYS.STRIP_INLINE_STYLES]: stripEl.checked });
      });
    } catch (err) {
      log(LL.WARN, 'Failed to load capture toggles', err);
    }
  }

  private async loadStats() {
    try {
      const cast = await chrome.storage.local.get(STORAGE_KEYS.CAST_COUNT);
      const castCount = (cast[STORAGE_KEYS.CAST_COUNT] as number | undefined) ?? 0;
      const castEl = this.shadow.getElementById('cast-count');
      if (castEl) castEl.textContent = String(castCount);

      const countRes = await chrome.runtime.sendMessage({ type: 'GET_CLIP_COUNT' }).catch(() => null);
      const clipCount = (countRes?.success && typeof countRes.data?.count === 'number') ? countRes.data.count : 0;
      const clipEl = this.shadow.getElementById('clip-count');
      if (clipEl) clipEl.textContent = String(clipCount);
    } catch (err) {
      log(LL.WARN, 'Failed to load stats', err);
    }
  }

  private async exportClips() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CLIPS' }).catch(() => null);
    const clips: unknown[] = (res?.success && Array.isArray(res.data?.clips)) ? res.data.clips : [];
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

          <div class="form-block">
            <label class="block-label" for="note-input">Notes</label>
            <textarea id="note-input" maxlength="2000" placeholder="Add a note or comment (optional)…">${this.escapeHtml(this.note)}</textarea>
          </div>

          <div class="form-block evaluation">
            <div class="form-group">
              <label id="interest-label">Interest</label>
              <ul class="eval-listbox" id="interest-list" role="listbox" tabindex="0"
                  aria-labelledby="interest-label">
                ${(['Wise','Insightful','Interesting','Neutral','Noise'] as const).map(v =>
                  `<li role="option" class="eval-option${this.interest === v ? ' selected' : ''}"
                       data-value="${v}" aria-selected="${this.interest === v}">${v}</li>`
                ).join('')}
              </ul>
            </div>
            <div class="form-group">
              <label id="ethics-label">Ethics</label>
              <ul class="eval-listbox" id="ethics-list" role="listbox" tabindex="0"
                  aria-labelledby="ethics-label">
                ${(['Exemplary','Honest','Neutral','Misleading','Malicious'] as const).map(v =>
                  `<li role="option" class="eval-option${this.ethics === v ? ' selected' : ''}"
                       data-value="${v}" aria-selected="${this.ethics === v}">${v}</li>`
                ).join('')}
              </ul>
            </div>
            <div class="form-group">
              <label for="category">Category</label>
              <div class="combobox" id="category-combobox">
                <input type="text" id="category" value="${this.escapeHtml(this.category)}" autocomplete="off" spellcheck="false" />
                <button type="button" class="combobox-toggle" id="category-toggle" tabindex="-1">▾</button>
                <ul class="combobox-list" id="category-list" role="listbox">
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
            <div class="publish-mode-slider${!isConnected ? ' guest' : ''}" role="radiogroup" aria-label="Publish mode">
              <div class="slider-track">
                <div class="slider-pill" id="slider-pill"></div>
                <button class="slider-seg${this.publishMode === 'cast' ? ' active' : ''}"
                        id="seg-cast" role="radio" aria-checked="${this.publishMode === 'cast'}"
                        ${!isConnected ? 'disabled' : ''}
                        title="Publish to Nostr — your clip is public and signed with your identity">📡 Cast</button>
                <button class="slider-seg${this.publishMode === 'both' ? ' active' : ''}"
                        id="seg-both" role="radio" aria-checked="${this.publishMode === 'both'}"
                        ${!isConnected ? 'disabled' : ''}
                        title="Save privately and publish to Nostr — you keep a local copy too">🔒📡 Both</button>
                <button class="slider-seg${this.publishMode === 'local' ? ' active' : ''}"
                        id="seg-local" role="radio" aria-checked="${this.publishMode === 'local'}"
                        title="Keep private — stored only on this device, never published">🔒 Local</button>
              </div>
            </div>
          </div>
          <button class="btn btn-clip" id="clip" disabled>
            <span class="icon" id="clip-icon">${this.getClipIcon()}</span>
            <span class="label">CLIP</span>
            <span class="sublabel" id="clip-sublabel">${this.getClipSublabel()}</span>
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
        this.updatePreview();
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

    // ── Listbox helpers ───────────────────────────────────────────────────────
    const updateListbox = (list: Element, value: string) => {
      list.querySelectorAll<HTMLElement>('[role="option"]').forEach(li => {
        const sel = li.dataset.value === value;
        li.classList.toggle('selected', sel);
        li.setAttribute('aria-selected', String(sel));
      });
    };

    const listboxKeydown = (e: KeyboardEvent, list: Element, onSelect: (v: string) => void) => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
      e.preventDefault();
      const opts = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
      const cur = opts.findIndex(o => o.classList.contains('selected'));
      let next = cur;
      if (e.key === 'ArrowDown') next = Math.min(cur + 1, opts.length - 1);
      if (e.key === 'ArrowUp')   next = Math.max(cur - 1, 0);
      if (e.key === 'Home')      next = 0;
      if (e.key === 'End')       next = opts.length - 1;
      if (next === cur) return;
      const v = opts[next]!.dataset.value ?? '';
      onSelect(v);
      updateListbox(list, v);
      opts[next]!.scrollIntoView({ block: 'nearest' });
    };

    // ── Interest listbox ──────────────────────────────────────────────────────
    const interestList = this.shadow.getElementById('interest-list')!;
    interestList.addEventListener('click', e => {
      const t = (e.target as Element).closest<HTMLElement>('[data-value]');
      if (!t) return;
      this.interest = t.dataset.value as InterestLevel;
      updateListbox(interestList, this.interest);
      void chrome.storage.local.set({ [STORAGE_KEYS.LAST_INTEREST]: this.interest });
      this.validateForm();
    });
    interestList.addEventListener('keydown', e => listboxKeydown(e, interestList, v => {
      this.interest = v as InterestLevel;
      void chrome.storage.local.set({ [STORAGE_KEYS.LAST_INTEREST]: this.interest });
      this.validateForm();
    }));

    // ── Ethics listbox ────────────────────────────────────────────────────────
    const ethicsList = this.shadow.getElementById('ethics-list')!;
    ethicsList.addEventListener('click', e => {
      const t = (e.target as Element).closest<HTMLElement>('[data-value]');
      if (!t) return;
      this.ethics = t.dataset.value as EthicsLevel;
      updateListbox(ethicsList, this.ethics);
      void chrome.storage.local.set({ [STORAGE_KEYS.LAST_ETHICS]: this.ethics });
      this.validateForm();
    });
    ethicsList.addEventListener('keydown', e => listboxKeydown(e, ethicsList, v => {
      this.ethics = v as EthicsLevel;
      void chrome.storage.local.set({ [STORAGE_KEYS.LAST_ETHICS]: this.ethics });
      this.validateForm();
    }));

    // ── Publish-mode slider ───────────────────────────────────────────────────
    const pill = this.shadow.getElementById('slider-pill');
    const clipIconEl  = this.shadow.getElementById('clip-icon');
    const clipSublabelEl = this.shadow.getElementById('clip-sublabel');
    const order: PublishMode[] = ['cast', 'both', 'local'];

    const updateSlider = (suppressAnim = false) => {
      const idx = order.indexOf(this.publishMode);
      if (pill) {
        if (suppressAnim) pill.style.transition = 'none';
        pill.style.transform = `translateX(${idx * 100}%)`;
        if (suppressAnim) { void pill.offsetWidth; pill.style.transition = ''; }
      }
      this.shadow.querySelectorAll<HTMLElement>('.slider-seg').forEach(seg => {
        const segMode = seg.id.replace('seg-', '') as PublishMode;
        seg.classList.toggle('active', segMode === this.publishMode);
        seg.setAttribute('aria-checked', String(segMode === this.publishMode));
      });
      if (clipIconEl)     clipIconEl.textContent     = this.getClipIcon();
      if (clipSublabelEl) clipSublabelEl.textContent = this.getClipSublabel();
      const noticeEl = this.shadow.getElementById('cast-notice');
      if (noticeEl) noticeEl.innerHTML = this.renderCastNotice(isConnected);
    };

    (['cast', 'both', 'local'] as const).forEach(mode => {
      this.shadow.getElementById(`seg-${mode}`)?.addEventListener('click', () => {
        if (!isConnected && mode !== 'local') return;
        this.publishMode = mode;
        updateSlider();
        void chrome.storage.local.set({ [STORAGE_KEYS.LAST_PUBLISH_MODE]: mode });
      });
    });

    updateSlider(true); // position pill without animation on first render

    this.shadow.getElementById('nostr-signup-link')?.addEventListener('click', () => {
      this.identityBackTarget = 'main';
      this.view = 'identity';
      this.render();
    });

    this.shadow.getElementById('clip')?.addEventListener('click', () => this.handleClipAction());

    this.setupCategoryCombobox();
    this.validateForm();
  }



  private renderCastNotice(isConnected: boolean): string {
    const cap = this.capture;
    if (!cap) return '';
    if (!isConnected) return '';
    const willBroadcast = this.publishMode === 'cast' || this.publishMode === 'both';
    if (!willBroadcast) return '';

    const richFormats: ClipFormat[] = ['article', 'full-page'];
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
    this.updatePreview();

    let cap: Capture | null = null;
    try {
      cap = await this.opts.onCapture(this.format);
    } catch (err) {
      log(LL.WARN, 'Discerned: capture failed', err);
    }

    if (myGen !== this.captureGeneration) return; // a newer capture has started; discard
    this.capture = cap;
    this.capturing = false;
    this.updatePreview();
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

    // Populate category list from the unified categories array (initial + user-created).
    for (const c of this.customCategories) {
      const exists = Array.from(list.querySelectorAll('li')).some(li => li.dataset.value?.toLowerCase() === c.toLowerCase());
      if (!exists) {
        const li = document.createElement('li');
        li.dataset.value = c;
        li.textContent = c;
        list.appendChild(li);
      }
    }

    const openList  = () => list.classList.add('open');
    const closeList = () => list.classList.remove('open');

    const selectValue = (value: string) => {
      input.value = value;
      this.category = value;
      void chrome.storage.local.set({ [STORAGE_KEYS.LAST_CATEGORY]: value });
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
        void chrome.storage.local.set({ [STORAGE_KEYS.CATEGORIES]: [...this.customCategories] });
        void chrome.runtime.sendMessage({ type: 'SYNC_CATEGORIES_TO_WEB' });
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

    input.addEventListener('input', () => { this.category = input.value; this.validateForm(); });
    input.addEventListener('blur', () => {
      addCustomIfNew(input.value);
      if (input.value.trim()) {
        this.category = input.value.trim();
        void chrome.storage.local.set({ [STORAGE_KEYS.LAST_CATEGORY]: this.category });
      }
      closeList();
    });
  }

  private validateForm() {
    const category = (this.shadow.getElementById('category') as HTMLInputElement | null)?.value.trim();
    const isValid = !!(this.interest && this.ethics && category) && !!this.capture && !this.capturing;
    const clipBtn = this.shadow.getElementById('clip') as HTMLButtonElement | null;
    if (clipBtn) clipBtn.disabled = !isValid;
  }

  private getEvaluation(): Evaluation {
    const category = ((this.shadow.getElementById('category') as HTMLInputElement).value.trim() || 'General') as Category;
    return { interest: this.interest, ethics: this.ethics, category };
  }

  private async handleClipAction() {
    if (!this.opts || !this.capture) return;
    const isConnected = this.authState.type !== 'guest';
    const mode: PublishMode = isConnected ? this.publishMode : 'local';
    const evaluation = this.getEvaluation();
    const noteEl = this.shadow.getElementById('note-input') as HTMLTextAreaElement | null;
    const note = (noteEl?.value ?? '').trim();
    const captureWithNote: Capture = note ? { ...this.capture, note } : this.capture;

    this.showLoading('Saving…');

    if (mode === 'local') {
      try { await this.opts.onClip(captureWithNote, evaluation); }
      catch { this.showError('Failed to clip. Please try again.'); return; }
      this.removePreview();
      this.showSuccess('Clipped! 🔒', captureWithNote.id);

    } else if (mode === 'cast') {
      // CAST only publishes to Nostr; local save requires an explicit CLIP action
      this.removePreview();
      this.showSuccess('📡 Broadcasting…', undefined, true);
      this.opts.onCast(captureWithNote, evaluation).catch((err: unknown) => {
        log(LL.WARN, 'Discerned: cast failed', err instanceof Error ? err.message : err);
      });

    } else {
      // both: explicit local save first, then broadcast (idempotent double-save is safe)
      try { await this.opts.onClip(captureWithNote, evaluation); }
      catch { this.showError('Failed to clip. Please try again.'); return; }
      this.removePreview();
      this.showSuccess('Clipped! 📡 Broadcasting…', captureWithNote.id);
      this.opts.onCast(captureWithNote, evaluation).catch((err: unknown) => {
        log(LL.WARN, 'Discerned: broadcast failed (clip already saved locally)',
          err instanceof Error ? err.message : err);
      });
    }

    void chrome.storage.local.set({
      [STORAGE_KEYS.LAST_PUBLISH_MODE]: this.publishMode,
      [STORAGE_KEYS.LAST_INTEREST]:     this.interest,
      [STORAGE_KEYS.LAST_ETHICS]:       this.ethics,
      [STORAGE_KEYS.LAST_CATEGORY]:     evaluation.category,
    });
  }

  private showLoading(text: string) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    loading.style.display = 'flex';
    const p = loading.querySelector('p');
    if (p) p.textContent = text;
  }

  private showSuccess(message: string, clipId?: string, castOnly = false) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    let linkHtml = '';
    if (clipId) {
      linkHtml = `<button class="open-library-btn">View in Library →</button>`;
    } else if (castOnly) {
      linkHtml = `<button class="open-library-btn">View in discerned.online →</button>`;
    }
    loading.innerHTML = `<div class="success">✓ ${this.escapeHtml(message)}${linkHtml ? `<br>${linkHtml}` : ''}<br><button class="dismiss-btn">Dismiss</button></div>`;
    if (clipId) {
      loading.querySelector('.open-library-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY', clipId }).catch(() => {});
        this.hide();
      });
    } else if (castOnly) {
      loading.querySelector('.open-library-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_HOME' }).catch(() => {});
        this.hide();
      });
    }
    loading.querySelector('.dismiss-btn')?.addEventListener('click', () => this.hide());
  }

  private showError(message: string) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    loading.innerHTML = `<div class="error">✗ ${this.escapeHtml(message)}</div>`;
    setTimeout(() => { loading.style.display = 'none'; }, 2500);
  }

  private getClipIcon(): string {
    if (this.publishMode === 'local') return '🔒';
    if (this.publishMode === 'cast')  return '📡';
    return '🔒📡';
  }

  private getClipSublabel(): string {
    if (this.publishMode === 'local') return 'Private storage';
    if (this.publishMode === 'cast')  return 'Nostr only';
    return 'Clip & broadcast';
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
        max-width: 100%; max-height: 120px; width: auto; height: auto;
        object-fit: contain; border-radius: 6px; align-self: flex-start;
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
      .publish-mode-slider { display: flex; align-items: center; }
      .slider-track {
        position: relative; display: grid; grid-template-columns: repeat(3, 1fr);
        background: #252525; border: 1px solid #3a3a3a; border-radius: 8px;
        overflow: hidden; height: 28px; width: 174px;
      }
      .slider-pill {
        position: absolute; top: 2px; bottom: 2px; left: 2px;
        width: calc(33.333% - 2px); background: #0ea5e9; border-radius: 6px;
        pointer-events: none;
        transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
        will-change: transform;
      }
      .slider-seg {
        position: relative; z-index: 1; background: none; border: none;
        color: #888; font-size: 10px; font-weight: 500; cursor: pointer;
        padding: 0 4px; display: flex; align-items: center; justify-content: center;
        gap: 2px; white-space: nowrap; transition: color 0.15s; font-family: inherit;
      }
      .slider-seg:hover:not(:disabled) { color: #ddd; }
      .slider-seg.active { color: #fff; font-weight: 600; }
      .slider-seg:disabled { opacity: 0.4; cursor: not-allowed; }
      .publish-mode-slider.guest .slider-seg:not(#seg-local) { opacity: 0.4; cursor: not-allowed; }
      .slider-seg:focus-visible { outline: 2px solid #0ea5e9; outline-offset: -2px; border-radius: 6px; }

      .eval-listbox {
        list-style: none; background: #2a2a2a; border: 1px solid #444;
        border-radius: 6px; overflow-y: auto; max-height: 130px;
        padding: 2px 0; margin: 0; outline: none;
      }
      .eval-listbox:focus { border-color: #0ea5e9; box-shadow: 0 0 0 3px rgba(14,165,233,0.1); }
      .eval-option {
        padding: 5px 10px; font-size: 12px; color: #bbb; cursor: pointer;
        user-select: none; transition: background 0.1s, color 0.1s;
      }
      .eval-option:hover { background: #353535; color: #fff; }
      .eval-option.selected { background: #0c4a6e; color: #7dd3fc; font-weight: 600; }

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
      .usage-row-link { background: none; border: none; width: 100%; cursor: pointer; border-radius: 4px; padding: 2px 4px; margin: -2px -4px; transition: background 0.15s; font-family: inherit; }
      .usage-row-link:hover { background: #2a2a2a; color: #e8e8e8; }
      .usage-row-link:hover .usage-value { color: #7dd3fc; }
      .usage-value { color: #e8e8e8; font-weight: 600; }
      .pin-unlock summary { font-size: 12px; color: #888; cursor: pointer; }
      .pin-row { display: flex; gap: 6px; margin-top: 6px; }
      .pin-row input { flex: 1; background: #252525; border: 1px solid #3a3a3a; border-radius: 4px; color: #e8e8e8; font-size: 12px; padding: 6px 8px; outline: none; }
      .pin-row .btn { padding: 6px 10px; font-size: 12px; }
      .pin-error { font-size: 12px; color: #f87171; margin-top: 4px; }
      .toggle-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
      .toggle-row input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; accent-color: #0ea5e9; width: 14px; height: 14px; cursor: pointer; }
      .toggle-label { display: flex; flex-direction: column; gap: 2px; }
      .toggle-title { font-size: 12px; color: #e8e8e8; }
      .toggle-desc  { font-size: 11px; color: #888; line-height: 1.45; }

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
      .open-library-btn {
        margin-top: 10px; background: none; border: none; padding: 0;
        color: #3b82f6; font-size: 13px; cursor: pointer; text-decoration: underline;
      }
      .open-library-btn:hover { color: #60a5fa; }
      .dismiss-btn {
        margin-top: 8px; background: none; border: none; padding: 0;
        color: #666; font-size: 12px; cursor: pointer; text-decoration: underline;
      }
      .dismiss-btn:hover { color: #aaa; }
    `;
  }
}

// Register the custom element (guard against double-registration on re-injection)
try {
  if (!customElements.get('discerned-overlay')) {
    customElements.define('discerned-overlay', DiscernedOverlay);
  }
} catch { /* not a standard browsing context (iframe, worker, etc.) — skip registration */ }
