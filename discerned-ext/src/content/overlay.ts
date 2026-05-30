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
import { getNIP07PublicKey } from '@/shared/nostr/auth';

// Cached NIP-05 for the current user; populated lazily when the settings drawer
// opens. Settings re-renders read from here so we don't message the background
// on every render.
let cachedNip05: string | null = null;
let cachedNip05Pubkey: string | null = null;

export interface OverlayShowOptions {
  initialFormat: ClipFormat;
  hasSelection: boolean;
  onCapture: (format: ClipFormat) => Promise<Capture>;
  onClip: (capture: Capture, evaluation: Evaluation) => Promise<void>;
  onCast: (capture: Capture, evaluation: Evaluation) => Promise<string | undefined>;
  authState: AuthState;
  nudgeDismissed: boolean;
}

type View = 'gate' | 'identity' | 'main' | 'settings' | 'keyBackup';

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
  private identityStep: 'choose' | 'existing' | 'create' = 'choose';
  private initialConnectTab: 'nip07' | 'nip46' | 'nsec' = 'nip07';
  private generatedNsec: string | null = null;
  private generatedNpub: string | null = null;
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
    this.generatedNsec = null;
    this.generatedNpub = null;
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
      case 'gate':      this.renderGate();      break;
      case 'identity':  this.renderIdentity();  break;
      case 'settings':  this.renderSettings();  break;
      case 'keyBackup': this.renderKeyBackup(); break;
      case 'main':      this.renderMain();      break;
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
            Your clips and evaluations will be stored locally. Connect an identity to also broadcast publicly,
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
      this.identityStep = 'choose';
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
    switch (this.identityStep) {
      case 'create':   this.renderCreateAccount();   break;
      case 'existing': this.renderConnectExisting();  break;
      default:         this.renderIdentityChooser();  break;
    }
  }

  /** First screen after "Connect an identity": pick existing vs. create new. */
  private renderIdentityChooser() {
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
          <button class="choice-card" id="choice-existing" type="button">
            <div class="choice-title">Connect existing identity →</div>
            <div class="choice-desc">Already on Nostr? Use a signing extension, remote signer, or your private key.</div>
          </button>
          <button class="choice-card" id="choice-create" type="button">
            <div class="choice-title">Create new Nostr account →</div>
            <div class="choice-desc">New to Nostr? Generate a fresh keypair and back it up.</div>
          </button>
        </div>
      </div>
    `;
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('identity-back')?.addEventListener('click', () => {
      // Leaving the identity flow — don't keep a generated secret around.
      this.generatedNsec = null;
      this.generatedNpub = null;
      this.view = this.identityBackTarget;
      this.render();
      if (this.view === 'main' && !this.capture) void this.refreshCapture();
    });
    this.shadow.getElementById('choice-existing')?.addEventListener('click', () => {
      this.identityStep = 'existing';
      this.initialConnectTab = 'nip07';
      this.render();
    });
    this.shadow.getElementById('choice-create')?.addEventListener('click', () => {
      this.identityStep = 'create';
      this.render();
    });
  }

  /** "Create new Nostr account" step — generate a keypair, then go to backup. */
  private renderCreateAccount() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <button class="icon-btn back-btn" id="identity-back" aria-label="Back">←</button>
          <h2>Create account</h2>
          <div class="header-actions">
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="panel-body identity-body">
          <p class="panel-desc">
            This generates a brand-new Nostr keypair right here in your browser.
            You'll see both keys once and must back them up — your private key can
            never be recovered if lost. Nothing is saved until you store it next.
          </p>
          <button class="btn btn-primary" id="btn-generate-nsec" type="button">Generate keypair</button>
          <p class="identity-status" id="create-status"></p>
        </div>
      </div>
    `;
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('identity-back')?.addEventListener('click', () => {
      this.identityStep = 'choose';
      this.render();
    });
    this.shadow.getElementById('btn-generate-nsec')?.addEventListener('click', async () => {
      const status = this.shadow.getElementById('create-status');
      const btn    = this.shadow.getElementById('btn-generate-nsec') as HTMLButtonElement | null;
      this.setIdentityStatus(status, 'Generating…', 'spin');
      if (btn) btn.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'GENERATE_NSEC' }).catch(() => null);
      if (btn) btn.disabled = false;
      if (res?.success && typeof res.data?.nsec === 'string' && typeof res.data?.npub === 'string') {
        this.generatedNsec = res.data.nsec;
        this.generatedNpub = res.data.npub;
        this.view = 'keyBackup';
        this.render();
      } else {
        this.setIdentityStatus(status, res?.error ?? 'Failed to generate key. Please try again.', 'error');
      }
    });
  }

  /** "Connect existing identity" step — the three connect methods. */
  private renderConnectExisting() {
    const ev = this.escapeHtml.bind(this);
    const prefillNsec = this.generatedNsec ? ev(this.generatedNsec) : '';
    const nip07Detected = this.authState.type === 'pro';
    // Active tab: honour an explicit request (e.g. nsec after key creation),
    // otherwise default to Extension when NIP-07 is already detected.
    const activeTab = this.initialConnectTab;
    const tab = (id: 'nip07' | 'nip46' | 'nsec') => activeTab === id ? ' active' : '';
    const panelHidden = (id: 'nip07' | 'nip46' | 'nsec') => activeTab === id ? '' : ' style="display:none"';

    const nip07Panel = nip07Detected
      ? `
            <p class="identity-status ok"><span class="status-dot ok"></span>Signing extension detected — you're connected.</p>
            <p class="panel-desc">Discerned will use your browser signing extension to sign casts. No key is stored here.</p>
            <button class="btn btn-primary" id="btn-use-nip07" type="button">Continue</button>
            <p class="identity-status" id="nip07-status"></p>
          `
      : `
            <p class="panel-desc">
              Install a signing extension like
              <a href="https://chrome.google.com/webstore/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp" target="_blank" rel="noopener noreferrer">nos2x</a> or
              <a href="https://chromewebstore.google.com/detail/alby-bitcoin-wallet-for-l/iokeahhehimjnekafflcihljlcjccdbe" target="_blank" rel="noopener noreferrer">Alby</a> 
              to sign with your Nostr identity. After installing, browse any page —
              Discerned detects it automatically. Or click below to check now.
            </p>
            <button class="btn btn-secondary" id="btn-detect-nip07" type="button">Detect extension now</button>
            <p class="identity-status" id="nip07-status"></p>
          `;

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
            <button class="tab-btn${tab('nip07')}" id="tab-nip07" type="button">Extension${nip07Detected ? ' ✓' : ''}</button>
            <button class="tab-btn${tab('nip46')}" id="tab-nip46" type="button">Remote signer</button>
            <button class="tab-btn${tab('nsec')}" id="tab-nsec"  type="button">Store key</button>
          </div>
          <div id="panel-nip07" class="identity-panel"${panelHidden('nip07')}>${nip07Panel}</div>
          <div id="panel-nip46" class="identity-panel"${panelHidden('nip46')}>
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
          <div id="panel-nsec" class="identity-panel"${panelHidden('nsec')}>
            <p class="panel-warning">
              ⚠️ Your private key gives full access to your identity.
              It will be encrypted with a PIN before being stored — only you can unlock it.
            </p>
            <textarea id="nsec-input" rows="2" placeholder="nsec1…">${prefillNsec}</textarea>
            <input type="password" id="pin-input" placeholder="PIN (minimum 6 characters)" />
            <input type="password" id="pin-confirm" placeholder="Confirm PIN" />
            <button class="btn btn-primary" id="btn-save-nsec" type="button">Encrypt and store</button>
            <p class="identity-status" id="nsec-status"></p>
          </div>
        </div>
      </div>
    `;
    this.attachConnectExistingListeners();
  }

  private attachConnectExistingListeners() {
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('identity-back')?.addEventListener('click', () => {
      this.identityStep = 'choose';
      this.render();
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
        this.authState = res.data;
        // Re-render so the detected state (✓ + Continue) is reflected.
        this.render();
      } else {
        this.setIdentityStatus(status, 'No extension found. Install Alby or nos2x, visit any page, then try again.', 'error');
      }
    });

    // NIP-07 already detected — "Continue" just dismisses to the main view.
    this.shadow.getElementById('btn-use-nip07')?.addEventListener('click', () => {
      this.view = 'main';
      this.render();
      void this.refreshCapture();
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
        this.setIdentityStatus(status, 'Stored!', 'ok');
        // Stored — the just-generated key (if any) no longer needs to linger.
        this.generatedNsec = null;
        this.generatedNpub = null;
        const refreshed = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
        if (refreshed?.success && refreshed.data) this.authState = refreshed.data as AuthState;
        setTimeout(() => { this.view = 'main'; this.render(); void this.refreshCapture(); }, 900);
      } else {
        this.setIdentityStatus(status, res.error ?? 'Failed to store key. Please try again.', 'error');
      }
    });
  }

  // ── Key backup (shown once after generating a new account) ──────────────────

  private renderKeyBackup() {
    const ev = this.escapeHtml.bind(this);
    const npub = this.generatedNpub ?? '';
    const nsec = this.generatedNsec ?? '';
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <h2>Back up your keys</h2>
          <div class="header-actions">
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="panel-body identity-body">
          <p class="panel-warning">
            ⚠️ This is the only time your private key is shown. Save both keys somewhere
            safe (a password manager). Anyone with the private key controls your identity,
            and it can never be recovered if lost.
          </p>
          <div class="key-label">Public key (npub) — shareable</div>
          <div class="key-backup-box" id="npub-backup">${ev(npub)}</div>
          <button class="btn btn-secondary" id="btn-copy-npub" type="button">Copy public key</button>
          <div class="key-label">Private key (nsec) — keep secret</div>
          <div class="key-backup-box" id="nsec-backup">${ev(nsec)}</div>
          <button class="btn btn-secondary" id="btn-copy-nsec" type="button">Copy private key</button>
          <label class="key-ack">
            <input type="checkbox" id="ack-saved" /> I've saved my keys somewhere safe
          </label>
          <button class="btn btn-primary" id="btn-backup-done" type="button" disabled>Done</button>
          <p class="identity-status" id="backup-status"></p>
        </div>
      </div>
    `;
    this.attachKeyBackupListeners();
  }

  private attachKeyBackupListeners() {
    this.shadow.getElementById('close')?.addEventListener('click', () => this.finishKeyBackup());

    const copy = async (text: string) => {
      const status = this.shadow.getElementById('backup-status');
      try {
        await navigator.clipboard.writeText(text);
        this.setIdentityStatus(status, 'Copied to clipboard.', 'ok');
      } catch {
        this.setIdentityStatus(status, 'Copy failed — select the key and copy manually.', 'error');
      }
    };
    this.shadow.getElementById('btn-copy-npub')?.addEventListener('click', () => void copy(this.generatedNpub ?? ''));
    this.shadow.getElementById('btn-copy-nsec')?.addEventListener('click', () => void copy(this.generatedNsec ?? ''));

    const ack  = this.shadow.getElementById('ack-saved')      as HTMLInputElement  | null;
    const done = this.shadow.getElementById('btn-backup-done') as HTMLButtonElement | null;
    ack?.addEventListener('change', () => { if (done) done.disabled = !ack.checked; });
    done?.addEventListener('click', () => this.finishKeyBackup());
  }

  /**
   * After backing up a freshly-created keypair, go straight to "Connect identity"
   * with the Store key tab open and the new nsec prefilled — the natural next step
   * is to encrypt and store it. The generated nsec is kept in memory for the
   * prefill and cleared once stored (btn-save-nsec) or on leaving the flow.
   */
  private finishKeyBackup() {
    this.view = 'identity';
    this.identityStep = 'existing';
    this.initialConnectTab = 'nsec';
    this.render();
  }

  private setIdentityStatus(el: Element | null, text: string, kind: 'error' | 'ok' | 'spin') {
    if (!el) return;
    el.className = `identity-status ${kind}`;
    if (kind === 'spin') el.innerHTML = `<span class="spinner-inline"></span>${this.escapeHtml(text)}`;
    else el.textContent = text;
  }

  // ── Settings drawer (auth status, stats, export) ───────────────────────────

  /**
   * Fetch the user's NIP-05 (and, for pro mode, their pubkey first) on
   * settings-open. Re-renders settings if the result differs from the current
   * cached value. Safe to call repeatedly — module-level cache prevents
   * redundant background round-trips.
   */
  private async loadNip05ForSettings(): Promise<void> {
    const auth = this.authState;
    if (auth.type === 'guest') return;

    // pro mode: lazy-fetch the NIP-07 pubkey if background doesn't have it yet.
    // The wallet typically only prompts the first time per origin.
    if (auth.type === 'pro' && !auth.pubkey) {
      try {
        const pk = await getNIP07PublicKey();
        if (pk) {
          await chrome.runtime.sendMessage({ type: 'NIP07_DETECTED', hasNIP07: true, pubkey: pk });
          // Refresh local authState so subsequent renders include the pubkey.
          const refreshed = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
          if (refreshed?.success && refreshed.data) {
            this.authState = refreshed.data as AuthState;
          }
        }
      } catch (err) {
        log(LL.DEBUG, '[nip05] NIP-07 pubkey fetch failed', err);
      }
    }

    const pubkey = this.authState.type === 'pro' ? this.authState.pubkey
      : this.authState.type === 'nip46' ? this.authState.pubkey
      : this.authState.type === 'nsec' ? this.authState.pubkey
      : null;
    if (!pubkey) return;

    const res = await chrome.runtime.sendMessage({ type: 'GET_NIP05_FOR_ME' }).catch(() => null);
    const nip05 = (res?.success && res.data && typeof (res.data as { nip05?: unknown }).nip05 === 'string')
      ? (res.data as { nip05: string }).nip05
      : null;

    const changed = nip05 !== cachedNip05 || pubkey !== cachedNip05Pubkey;
    cachedNip05 = nip05;
    cachedNip05Pubkey = pubkey;
    if (changed && this.view === 'settings') {
      this.render();
    }
  }

  private renderSettings() {
    const ev = this.escapeHtml.bind(this);
    const auth = this.authState;
    const formatPubkey = (pk: string) => {
      try { const npub = npubEncode(pk); return `${npub.slice(0, 16)}…${npub.slice(-8)}`; } catch { return pk; }
    };
    const identityBlock = (pk: string): string => {
      const nip05Line = cachedNip05 && cachedNip05Pubkey === pk
        ? `<div class="profile-id"><span class="profile-id-label">NIP-05:</span> ${ev(cachedNip05)}</div>`
        : '';
      return `${nip05Line}<div class="profile-id"><span class="profile-id-label">npub:</span> ${ev(formatPubkey(pk))}</div>`;
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
          ${auth.pubkey ? identityBlock(auth.pubkey) : ''}
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
          ${identityBlock(auth.pubkey)}
        </div>
      `;
    } else {
      authBlock = `
        <div class="settings-card">
          <div class="card-row">
            <div>
              <div class="card-label">Status</div>
              <div class="card-value ok">Connected with stored key</div>
            </div>
            <button class="link-btn" id="settings-disconnect">Disconnect</button>
          </div>
          ${identityBlock(auth.pubkey)}
          <details class="pin-unlock">
            <summary>View / unlock your key</summary>
            <div class="pin-row">
              <input type="password" id="settings-pin" placeholder="Enter your PIN" />
              <button class="btn btn-secondary" id="settings-unlock">Unlock</button>
            </div>
            <div class="pin-error" id="settings-pin-error"></div>
            <div class="key-reveal" id="settings-key-reveal"></div>
          </details>
        </div>
      `;
    }

    void this.loadNip05ForSettings();

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
      this.identityStep = 'choose';
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
      const pinEl    = this.shadow.getElementById('settings-pin') as HTMLInputElement | null;
      const errEl    = this.shadow.getElementById('settings-pin-error');
      const revealEl = this.shadow.getElementById('settings-key-reveal');
      const pin = pinEl?.value ?? '';
      if (!pin) return;
      const res = await chrome.runtime.sendMessage({ type: 'UNLOCK_NSEC', pin });
      if (!res.success) {
        if (errEl) errEl.textContent = 'Incorrect PIN. Please try again.';
        if (revealEl) revealEl.innerHTML = '';
        return;
      }
      if (errEl) errEl.textContent = '';
      const ev = this.escapeHtml.bind(this);
      const npub = typeof res.data?.npub === 'string' ? res.data.npub : '';
      const nsec = typeof res.data?.nsec === 'string' ? res.data.nsec : '';
      if (revealEl) {
        revealEl.innerHTML = `
          <p class="panel-warning">⚠️ Keep your private key secret — anyone with it controls your identity.</p>
          <div class="key-label">Public key (npub)</div>
          <div class="key-backup-box" id="reveal-npub">${ev(npub)}</div>
          <button class="btn btn-secondary" id="reveal-copy-npub" type="button">Copy public key</button>
          <div class="key-label">Private key (nsec)</div>
          <div class="key-backup-box" id="reveal-nsec">${ev(nsec)}</div>
          <button class="btn btn-secondary" id="reveal-copy-nsec" type="button">Copy private key</button>
        `;
        revealEl.querySelector('#reveal-copy-npub')?.addEventListener('click', () => {
          navigator.clipboard.writeText(npub).catch(() => {});
        });
        revealEl.querySelector('#reveal-copy-nsec')?.addEventListener('click', () => {
          navigator.clipboard.writeText(nsec).catch(() => {});
        });
      }
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
              <label for="category">Category</label>
              <div class="combobox" id="category-combobox">
                <input type="text" id="category" value="${this.escapeHtml(this.category)}" autocomplete="off" spellcheck="false" />
                <button type="button" class="combobox-toggle" id="category-toggle" tabindex="-1">▾</button>
                <ul class="combobox-list" id="category-list" role="listbox">
                </ul>
              </div>
            </div>
            <div class="form-group">
              <label id="interest-label">Interest</label>
              ${this.renderEqSlider({
                id: 'interest',
                lowToHigh: ['Noise','Neutral','Interesting','Insightful','Wise'],
                value: this.interest,
                labelledBy: 'interest-label',
              })}
            </div>
            <div class="form-group">
              <label id="ethics-label">Ethics</label>
              ${this.renderEqSlider({
                id: 'ethics',
                lowToHigh: ['Malicious','Misleading','Neutral','Honest','Exemplary'],
                value: this.ethics,
                labelledBy: 'ethics-label',
              })}
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
    // ── EQ sliders (Interest + Ethics) ────────────────────────────────────────
    this.attachEqSlider({
      id: 'interest',
      lowToHigh: ['Noise','Neutral','Interesting','Insightful','Wise'],
      get: () => this.interest,
      set: v => {
        this.interest = v as InterestLevel;
        void chrome.storage.local.set({ [STORAGE_KEYS.LAST_INTEREST]: this.interest });
        this.validateForm();
      },
    });
    this.attachEqSlider({
      id: 'ethics',
      lowToHigh: ['Malicious','Misleading','Neutral','Honest','Exemplary'],
      get: () => this.ethics,
      set: v => {
        this.ethics = v as EthicsLevel;
        void chrome.storage.local.set({ [STORAGE_KEYS.LAST_ETHICS]: this.ethics });
        this.validateForm();
      },
    });

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

  /**
   * Vertical equalizer-style slider for an evaluation axis. `lowToHigh[0]` sits
   * at the bottom (most negative) and `lowToHigh.at(-1)` at the top (most
   * positive). Labels render top → bottom (reverse of options).
   */
  private renderEqSlider(opts: {
    id: string;
    lowToHigh: readonly string[];
    value: string;
    labelledBy: string;
  }): string {
    const n = opts.lowToHigh.length;
    const idx = Math.max(0, opts.lowToHigh.indexOf(opts.value));
    const pct = (idx / (n - 1)) * 100;
    const ticks = opts.lowToHigh.map((_, i) =>
      `<div class="pop-eq-tick" style="bottom: calc(${(i / (n - 1)) * 100}% - 0.5px)"></div>`
    ).join('');
    const labels = [...opts.lowToHigh].reverse().map(opt =>
      `<div class="pop-eq-label${opt === opts.value ? ' selected' : ''}" data-value="${this.escapeHtml(opt)}">${this.escapeHtml(opt)}</div>`
    ).join('');
    return `
      <div class="pop-eq" data-eq-id="${opts.id}">
        <div class="pop-eq-slot" id="eq-${opts.id}-slot"
             role="slider" tabindex="0"
             aria-labelledby="${opts.labelledBy}"
             aria-valuemin="0" aria-valuemax="${n - 1}"
             aria-valuenow="${idx}" aria-valuetext="${this.escapeHtml(opts.value)}">
          <div class="pop-eq-ticks">${ticks}</div>
          <div class="pop-eq-track"></div>
          <div class="pop-eq-fill" style="top: calc(100% - ${pct}%)"></div>
          <div class="pop-eq-thumb" style="bottom: ${pct}%"><span class="pop-eq-thumb-groove"></span></div>
        </div>
        <div class="pop-eq-labels" id="eq-${opts.id}-labels">${labels}</div>
      </div>
    `;
  }

  /**
   * Wire up an EQ slider's click / drag / keyboard / label-click behavior.
   * The slider is rendered by {@link renderEqSlider}; this method finds it by id
   * inside the shadow root and binds listeners that drive a single getter/setter
   * pair held by the caller.
   *
   * Drag math mirrors the handoff spec: a 10px inset on top/bottom matches the
   * slot's `top:10px; bottom:10px` ticks/track padding, and the live drag follows
   * the cursor while a final `round` snaps to the nearest step on release.
   */
  private attachEqSlider(opts: {
    id: string;
    lowToHigh: readonly string[];
    get: () => string;
    set: (v: string) => void;
  }): void {
    const slot   = this.shadow.getElementById(`eq-${opts.id}-slot`)   as HTMLElement | null;
    const labels = this.shadow.getElementById(`eq-${opts.id}-labels`) as HTMLElement | null;
    if (!slot || !labels) return;

    const fill  = slot.querySelector<HTMLElement>('.pop-eq-fill');
    const thumb = slot.querySelector<HTMLElement>('.pop-eq-thumb');
    const n     = opts.lowToHigh.length;

    const SLOT_INSET = 10; // matches top:10px; bottom:10px in .pop-eq-track / .pop-eq-ticks

    const repaint = (idx: number, snap: boolean) => {
      const clamped = Math.max(0, Math.min(n - 1, snap ? Math.round(idx) : idx));
      const value = opts.lowToHigh[snap ? clamped : Math.round(clamped)]!;
      const pct = (clamped / (n - 1)) * 100;
      if (fill)  fill.style.top    = `calc(100% - ${pct}%)`;
      if (thumb) thumb.style.bottom = `${pct}%`;
      slot.setAttribute('aria-valuenow', String(Math.round(clamped)));
      slot.setAttribute('aria-valuetext', value);
      labels.querySelectorAll<HTMLElement>('.pop-eq-label').forEach(el => {
        el.classList.toggle('selected', el.dataset.value === value);
      });
      if (snap && value !== opts.get()) opts.set(value);
    };

    const indexFromClientY = (clientY: number): number => {
      const r = slot.getBoundingClientRect();
      const pct = 1 - (clientY - r.top - SLOT_INSET) / (r.height - SLOT_INSET * 2);
      return Math.max(0, Math.min(n - 1, pct * (n - 1)));
    };

    // Click / drag on the slot
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      dragging = true;
      slot.setPointerCapture(e.pointerId);
      repaint(indexFromClientY(e.clientY), false);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      repaint(indexFromClientY(e.clientY), false);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { slot.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      repaint(indexFromClientY(e.clientY), true);
    };
    slot.addEventListener('pointerdown', onDown);
    slot.addEventListener('pointermove', onMove);
    slot.addEventListener('pointerup', onUp);
    slot.addEventListener('pointercancel', onUp);

    // Label clicks → snap to that step
    labels.addEventListener('click', e => {
      const t = (e.target as Element).closest<HTMLElement>('.pop-eq-label');
      if (!t) return;
      const v = t.dataset.value;
      if (!v) return;
      const i = opts.lowToHigh.indexOf(v);
      if (i >= 0) repaint(i, true);
    });

    // Keyboard
    slot.addEventListener('keydown', e => {
      const cur = opts.lowToHigh.indexOf(opts.get());
      let next = cur;
      if (e.key === 'ArrowUp')        next = Math.min(cur + 1, n - 1);
      else if (e.key === 'ArrowDown') next = Math.max(cur - 1, 0);
      else if (e.key === 'PageUp')    next = Math.min(cur + 2, n - 1);
      else if (e.key === 'PageDown')  next = Math.max(cur - 2, 0);
      else if (e.key === 'Home')      next = n - 1;   // Home → top (most positive)
      else if (e.key === 'End')       next = 0;       // End  → bottom (most negative)
      else return;
      e.preventDefault();
      if (next !== cur) repaint(next, true);
    });
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
      this.showSuccess('Clipped! 🔒', { clipId: captureWithNote.id });

    } else if (mode === 'cast') {
      // CAST only publishes to Nostr; local save requires an explicit CLIP action.
      this.removePreview();
      this.showLoading('📡 Broadcasting…');
      try {
        const eventId = await this.opts.onCast(captureWithNote, evaluation);
        this.showSuccess('Cast published 📡', { eventId });
      } catch (err: unknown) {
        log(LL.WARN, 'Discerned: cast failed', err instanceof Error ? err.message : err);
        this.showError('Broadcast failed. Please try again.');
      }

    } else {
      // both: explicit local save first (idempotent double-save is safe), then broadcast.
      try { await this.opts.onClip(captureWithNote, evaluation); }
      catch { this.showError('Failed to clip. Please try again.'); return; }
      this.removePreview();
      this.showLoading('Clipped! 📡 Broadcasting…');
      try {
        const eventId = await this.opts.onCast(captureWithNote, evaluation);
        this.showSuccess('Clipped & cast 📡', { clipId: captureWithNote.id, eventId });
      } catch (err: unknown) {
        // Local clip already saved — surface the cast failure but keep the library link.
        log(LL.WARN, 'Discerned: broadcast failed (clip already saved locally)',
          err instanceof Error ? err.message : err);
        this.showSuccess('Clipped 🔒 · broadcast failed', { clipId: captureWithNote.id });
      }
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

  private showSuccess(message: string, opts: { clipId?: string; eventId?: string } = {}) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    const { clipId, eventId } = opts;
    const libraryBtn = clipId
      ? `<button class="open-library-btn">View in Library →</button>` : '';
    const discernmentBtn = eventId
      ? `<button class="open-discernment-btn">View in discernment →</button>` : '';
    const links = [libraryBtn, discernmentBtn].filter(Boolean).join('<br>');
    loading.innerHTML = `<div class="success">✓ ${this.escapeHtml(message)}${links ? `<br>${links}` : ''}<br><button class="dismiss-btn">Dismiss</button></div>`;
    if (clipId) {
      loading.querySelector('.open-library-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY', clipId }).catch(() => {});
        this.hide();
      });
    }
    if (eventId) {
      loading.querySelector('.open-discernment-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_HOME', eventId }).catch(() => {});
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
      :host {
        display: block;
        /* Reddit ships a global :not(:defined) visibility:hidden rule to hide
           un-upgraded custom elements. Our discerned-overlay is defined only in
           the content-script's isolated world, so in Reddit's page world it
           matches :not(:defined) and gets visibility:hidden directly on the host
           — which then inherits across the shadow boundary into our panel. That
           selector's specificity (two :not()s) beats a plain :host, so we need
           !important to win. */
        visibility: visible !important;

        /* ── Mint Tinted (translucent) — design tokens ──────────────────────── */
        --p-bg:        rgba(166, 210, 184, 0.55);
        --p-surface:   rgba(230, 243, 234, 0.65);
        --p-surface-2: rgba(198, 222, 207, 0.70);
        --p-ink:       #0f1a14;
        --p-ink-2:     #243029;
        --p-ink-3:     #4e5f55;
        --p-ink-4:     #788a80;
        --p-rule:      rgba(15, 26, 20, 0.18);
        --p-rule-soft: rgba(15, 26, 20, 0.10);
        --p-accent:     oklch(0.45 0.12 165);
        --p-accent-ink: oklch(0.36 0.10 165);
        --p-on-accent:  #ecf6f0;
        --p-cta-bg:     #14201a;
        --p-cta-ink:    #e6f3ea;
        --p-cta-shadow: rgba(20, 60, 40, 0.40);
      }
      * { margin: 0; padding: 0; box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

      .discerned-root.panel {
        visibility: visible;
        position: fixed; top: 0; left: 0; bottom: 0;
        width: 380px; max-width: 90vw;
        background: var(--p-bg);
        color: var(--p-ink);
        backdrop-filter: blur(18px) saturate(150%);
        -webkit-backdrop-filter: blur(18px) saturate(150%);
        border-right: 1px solid rgba(255, 255, 255, 0.40);
        box-shadow:
          24px 0 60px -20px var(--p-cta-shadow),
          inset 0 1px 0 rgba(255, 255, 255, 0.5);
        z-index: 2147483647;
        display: flex; flex-direction: column;
        animation: slideIn 0.18s ease-out;
      }
      /* Opaque fallback for browsers without backdrop-filter (some Firefox forks, older Chromium on Linux). */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .discerned-root.panel { background: #d8ebe0; }
      }
      @keyframes slideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }

      .panel-header {
        flex: 0 0 auto;
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--p-rule);
      }
      .panel-header h2 { color: var(--p-ink); font-size: 16px; font-weight: 600; flex: 1; }
      .header-actions { display: flex; gap: 4px; }

      .icon-btn {
        background: none; border: none; color: var(--p-ink-3);
        cursor: pointer; width: 30px; height: 30px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 5px; font-size: 18px; transition: all 0.15s;
      }
      .icon-btn:hover { background: var(--p-surface-2); color: var(--p-ink); }
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
        border-top: 1px solid var(--p-rule);
        background: transparent;
        display: flex; flex-direction: column; gap: 10px;
      }

      /* Format chips */
      .format-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip {
        background: var(--p-surface); border: 1px solid var(--p-rule);
        color: var(--p-ink-2); font-size: 12px;
        padding: 6px 10px; border-radius: 999px;
        cursor: pointer; transition: all 0.15s;
        display: inline-flex; align-items: center; gap: 6px;
        font-family: inherit;
      }
      .chip:hover:not(:disabled) { border-color: var(--p-accent); color: var(--p-ink); }
      .chip.active { background: var(--p-accent); border-color: var(--p-accent); color: var(--p-on-accent); }
      .chip:disabled { opacity: 0.4; cursor: not-allowed; }
      .chip-icon { font-size: 13px; }

      /* Preview area */
      .preview-area { display: block; }
      .preview-card {
        background: var(--p-surface); border-radius: 8px;
        border-left: 4px solid var(--p-accent);
        padding: 12px;
        display: flex; flex-direction: column; gap: 6px;
      }
      .preview-thumb {
        max-width: 100%; max-height: 120px; width: auto; height: auto;
        object-fit: contain; border-radius: 6px; align-self: flex-start;
      }
      .preview-title { color: var(--p-ink); font-size: 14px; font-weight: 600; }
      .preview-text  { color: var(--p-ink-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
      .preview-url   { color: var(--p-ink-3); font-size: 11px; word-break: break-all; }
      .preview-hint  { color: var(--p-accent-ink); font-size: 11px; }
      .preview-placeholder {
        background: var(--p-surface); border: 1px dashed var(--p-rule);
        border-radius: 6px; padding: 14px;
        color: var(--p-ink-3); font-size: 12px; text-align: center;
      }
      .preview-loading {
        display: flex; align-items: center; gap: 8px;
        color: var(--p-ink-3); font-size: 13px; padding: 14px;
      }
      .preview-empty { color: var(--p-ink-4); font-size: 12px; padding: 14px 0; }

      .form-block { display: flex; flex-direction: column; gap: 6px; }
      .block-label {
        color: var(--p-ink-2); font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .form-block.evaluation { display: flex; flex-direction: row; gap: 12px; align-items: flex-start; }
      .form-group { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      label {
        color: var(--p-ink-2); font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
      }

      textarea#note-input {
        width: 100%; min-height: 56px;
        background: var(--p-surface); border: 1px solid var(--p-rule);
        border-radius: 6px; color: var(--p-ink);
        font-family: inherit; font-size: 13px;
        padding: 8px 10px; resize: vertical;
        outline: none; transition: border-color 0.15s, box-shadow 0.15s;
      }
      textarea#note-input::placeholder { color: var(--p-ink-4); }
      textarea#note-input:focus { border-color: var(--p-accent); box-shadow: 0 0 0 3px rgba(42,102,80,0.15); }

      select {
        background: var(--p-surface); border: 1px solid var(--p-rule); color: var(--p-ink);
        padding: 8px; border-radius: 6px; font-size: 12px;
        width: 100%; font-family: inherit; cursor: pointer;
        transition: border-color 0.2s;
      }
      select:hover { border-color: var(--p-ink-3); }
      select:focus { outline: none; border-color: var(--p-accent); box-shadow: 0 0 0 3px rgba(42,102,80,0.15); }

      /* Combobox */
      .combobox { position: relative; display: flex; }
      .combobox input[type="text"] {
        flex: 1; min-width: 0; background: var(--p-surface);
        border: 1px solid var(--p-rule); border-right: none; color: var(--p-ink);
        padding: 8px; border-radius: 6px 0 0 6px;
        font-size: 12px; font-family: inherit; transition: border-color 0.2s;
      }
      .combobox-toggle {
        background: var(--p-surface); border: 1px solid var(--p-rule); border-left: none;
        color: var(--p-ink-3); padding: 0 8px; border-radius: 0 6px 6px 0;
        cursor: pointer; font-size: 11px; transition: border-color 0.2s;
      }
      .combobox:focus-within input[type="text"],
      .combobox:focus-within .combobox-toggle { border-color: var(--p-accent); }
      .combobox input[type="text"]:focus { outline: none; box-shadow: 0 0 0 3px rgba(42,102,80,0.15); }
      .combobox-toggle:hover { color: var(--p-ink); }

      .combobox-list {
        display: none; position: absolute; top: calc(100% + 3px); left: 0; right: 0;
        background: rgba(230, 243, 234, 0.95);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        border: 1px solid var(--p-rule); border-radius: 6px;
        list-style: none; z-index: 9999;
        max-height: 180px; overflow-y: auto;
        box-shadow: 0 6px 18px rgba(20,60,40,0.25);
      }
      .combobox-list.open { display: block; }
      .combobox-list li { padding: 7px 10px; color: var(--p-ink); font-size: 12px; cursor: pointer; font-family: inherit; }
      .combobox-list li:hover { background: var(--p-accent); color: var(--p-on-accent); }
      .combobox-list li.custom-entry { color: var(--p-ink-3); font-style: italic; }

      /* Cast notice */
      .cast-notice { min-height: 0; }
      .notice { font-size: 11px; line-height: 1.4; }
      .notice.ok   { color: var(--p-accent-ink); }
      .notice.warn { color: #8a5a00; }

      /* Footer meta */
      .footer-meta { display: flex; align-items: center; justify-content: space-between; }
      .nostr-status { display: flex; align-items: center; gap: 6px; }
      .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--p-ink-4); flex-shrink: 0; }
      .status-dot.connected { background: var(--p-accent); }
      .status-text { font-size: 11px; color: var(--p-ink-3); }
      .publish-mode-slider { display: flex; align-items: center; }
      .slider-track {
        position: relative; display: grid; grid-template-columns: repeat(3, 1fr);
        background: var(--p-surface-2); border: 1px solid var(--p-rule); border-radius: 8px;
        overflow: hidden; height: 28px; width: 174px;
      }
      .slider-pill {
        position: absolute; top: 2px; bottom: 2px; left: 2px;
        width: calc(33.333% - 2px); background: var(--p-accent); border-radius: 6px;
        pointer-events: none;
        transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
        will-change: transform;
      }
      .slider-seg {
        position: relative; z-index: 1; background: none; border: none;
        color: var(--p-ink-3); font-size: 10px; font-weight: 500; cursor: pointer;
        padding: 0 4px; display: flex; align-items: center; justify-content: center;
        gap: 2px; white-space: nowrap; transition: color 0.15s; font-family: inherit;
      }
      .slider-seg:hover:not(:disabled) { color: var(--p-ink); }
      .slider-seg.active { color: var(--p-on-accent); font-weight: 600; }
      .slider-seg:disabled { opacity: 0.4; cursor: not-allowed; }
      .publish-mode-slider.guest .slider-seg:not(#seg-local) { opacity: 0.4; cursor: not-allowed; }
      .slider-seg:focus-visible { outline: 2px solid var(--p-accent); outline-offset: -2px; border-radius: 6px; }

      /* ── EQ slider (Interest + Ethics) ─────────────────────────────────── */
      .pop-eq {
        display: grid;
        grid-template-columns: 28px 1fr;
        gap: 10px;
        height: 170px;
        align-items: stretch;
      }
      .pop-eq-slot {
        position: relative;
        width: 28px;
        border-radius: 6px;
        background: var(--p-surface);
        border: 1px solid var(--p-rule);
        box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.04);
        outline: none;
        overflow: hidden;
        touch-action: none;
        cursor: pointer;
      }
      .pop-eq-slot:focus-visible { box-shadow: 0 0 0 3px rgba(42,102,80,0.4); border-color: var(--p-accent); }
      .pop-eq-track {
        position: absolute;
        left: 50%; top: 10px; bottom: 10px;
        width: 4px;
        margin-left: -2px;
        background: var(--p-surface-2);
        border-radius: 2px;
        box-shadow: inset 0 0 0 1px var(--p-rule-soft);
        pointer-events: none;
      }
      .pop-eq-fill {
        position: absolute;
        left: 50%; bottom: 10px;
        width: 4px;
        margin-left: -2px;
        background: var(--p-accent);
        border-radius: 2px;
        opacity: 0.85;
        pointer-events: none;
        /* top is set inline so the fill ends at the thumb's center
           (which sits at bottom: pct%), not pct% above bottom:10px. */
      }
      .pop-eq-ticks {
        position: absolute;
        left: 4px; right: 4px;
        top: 10px; bottom: 10px;
        pointer-events: none;
      }
      .pop-eq-tick {
        position: absolute;
        left: 0; right: 0;
        height: 1px;
        background: var(--p-rule);
        opacity: 0.7;
      }
      .pop-eq-thumb {
        position: absolute;
        left: 50%;
        width: 22px; height: 11px;
        transform: translate(-50%, 50%);
        background: var(--p-ink);
        border-radius: 2px;
        box-shadow:
          0 1px 2px rgba(0, 0, 0, 0.35),
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          inset 0 -1px 0 rgba(0, 0, 0, 0.25);
        cursor: grab;
        z-index: 2;
        pointer-events: none;
      }
      .pop-eq-slot:active .pop-eq-thumb { cursor: grabbing; }
      .pop-eq-thumb-groove {
        position: absolute;
        left: 3px; right: 3px;
        top: 50%; height: 1px;
        margin-top: -0.5px;
        background: var(--p-ink-3);
        opacity: 0.7;
      }
      .pop-eq-labels {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 2px 0;
        font-size: 11.5px;
        line-height: 1;
        color: var(--p-ink-3);
      }
      .pop-eq-label {
        height: 11px;
        display: flex; align-items: center;
        cursor: pointer;
        transition: color .12s, font-weight .12s;
      }
      .pop-eq-label:hover { color: var(--p-ink-2); }
      .pop-eq-label.selected { color: var(--p-ink); font-weight: 600; }

      .link-btn {
        background: none; border: none; color: var(--p-accent-ink);
        font-size: 11px; cursor: pointer; padding: 0 0 0 6px;
        text-decoration: underline; font-family: inherit; line-height: 1;
      }
      .link-btn:hover { color: var(--p-accent); }

      /* Buttons */
      .btn {
        padding: 14px; border: none; border-radius: 8px;
        font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        font-family: inherit;
      }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 12px var(--p-cta-shadow); }
      .btn-secondary { background: var(--p-surface); color: var(--p-ink); border: 1px solid var(--p-rule); }
      .btn-secondary:not(:disabled):hover { background: var(--p-surface-2); }
      .btn-primary { background: var(--p-cta-bg); color: var(--p-cta-ink); }
      .btn-primary:not(:disabled):hover { background: #1d2e25; }
      .btn-clip {
        width: 100%;
        background: var(--p-cta-bg); color: var(--p-cta-ink);
        box-shadow: 0 2px 8px var(--p-cta-shadow);
      }
      .btn-clip:not(:disabled):hover { background: #1d2e25; }
      .btn-ghost { background: var(--p-surface); color: var(--p-ink-3); border: 1px solid var(--p-rule); }
      .btn-ghost:hover { background: var(--p-surface-2); color: var(--p-ink); }
      .btn .icon { font-size: 22px; }
      .btn .label { font-size: 13px; }
      .btn .sublabel { font-size: 11px; opacity: 0.7; font-weight: 400; }

      /* Gate */
      .gate-body {
        display: flex; flex-direction: column; align-items: center;
        text-align: center; padding: 28px 20px; gap: 14px;
      }
      .gate-icon { font-size: 40px; }
      .gate-title { font-size: 15px; font-weight: 600; color: var(--p-ink); }
      .gate-desc  { font-size: 12px; color: var(--p-ink-2); line-height: 1.6; max-width: 320px; }
      .gate-btn   { width: 100%; max-width: 280px; }

      /* Identity */
      .identity-body { display: flex; flex-direction: column; gap: 14px; }
      .identity-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--p-rule); }
      .tab-btn {
        background: none; border: none; border-bottom: 2px solid transparent;
        color: var(--p-ink-3); font-size: 12px; font-weight: 600;
        padding: 7px 14px; cursor: pointer; margin-bottom: -1px;
        transition: color 0.15s, border-color 0.15s;
      }
      .tab-btn:hover { color: var(--p-ink); }
      .tab-btn.active { color: var(--p-accent); border-bottom-color: var(--p-accent); }
      .identity-panel { display: flex; flex-direction: column; gap: 10px; }
      .panel-desc { font-size: 12px; color: var(--p-ink-2); line-height: 1.6; }
      .panel-desc a { color: var(--p-accent-ink); text-decoration: none; }
      .panel-desc a:hover { text-decoration: underline; }
      .panel-desc code { background: var(--p-surface); border: 1px solid var(--p-rule); border-radius: 3px; padding: 1px 5px; font-size: 0.9em; color: var(--p-accent-ink); }
      .panel-warning { background: rgba(240, 192, 64, 0.18); border: 1px solid rgba(180, 130, 0, 0.45); border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #5c3d00; line-height: 1.5; }
      textarea {
        width: 100%; background: var(--p-surface); border: 1px solid var(--p-rule);
        border-radius: 6px; color: var(--p-ink);
        font-family: monospace; font-size: 12px;
        padding: 10px; resize: vertical; min-height: 56px;
        outline: none; transition: border-color 0.15s;
      }
      textarea:focus { border-color: var(--p-accent); }
      input[type="password"] {
        width: 100%; background: var(--p-surface); border: 1px solid var(--p-rule);
        border-radius: 6px; color: var(--p-ink);
        font-size: 13px; padding: 10px;
        outline: none; transition: border-color 0.15s; font-family: inherit;
      }
      input[type="password"]:focus { border-color: var(--p-accent); }
      .identity-status { font-size: 12px; min-height: 16px; display: flex; align-items: center; gap: 6px; }
      .identity-status.error { color: #b91c1c; }
      .identity-status.ok    { color: var(--p-accent-ink); }
      .identity-status.spin  { color: var(--p-ink-2); }
      .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .status-dot.ok { background: #16a34a; }
      .identity-divider { display: flex; align-items: center; gap: 8px; color: var(--p-ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin: 4px 0; }
      .identity-divider::before, .identity-divider::after { content: ""; flex: 1; height: 1px; background: var(--p-rule); }
      .key-backup-box { font-family: monospace; font-size: 13px; color: var(--p-ink); background: var(--p-surface-2); border: 1px solid var(--p-rule); border-radius: 6px; padding: 12px; word-break: break-all; user-select: all; line-height: 1.5; }
      .key-ack { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--p-ink-2); cursor: pointer; }
      .key-ack input { cursor: pointer; }
      .key-label { font-size: 11px; font-weight: 600; color: var(--p-ink-3); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 4px; }
      .key-reveal { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
      .choice-card { display: block; width: 100%; text-align: left; background: var(--p-surface-2); border: 1px solid var(--p-rule); border-radius: 8px; padding: 14px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
      .choice-card:hover { border-color: var(--p-accent); background: var(--p-surface); }
      .choice-title { font-size: 14px; font-weight: 600; color: var(--p-accent-ink); margin-bottom: 4px; }
      .choice-desc { font-size: 12px; color: var(--p-ink-2); line-height: 1.5; }
      .spinner-inline {
        display: inline-block; width: 12px; height: 12px; flex-shrink: 0;
        border: 2px solid var(--p-rule); border-top-color: var(--p-accent);
        border-radius: 50%; animation: spin 0.7s linear infinite;
      }

      /* Settings */
      .settings-body { gap: 12px; }
      .settings-card {
        background: var(--p-surface); border: 1px solid var(--p-rule);
        border-radius: 8px; padding: 12px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .settings-card.warning { background: rgba(240, 192, 64, 0.18); border-color: rgba(180, 130, 0, 0.45); }
      .card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .card-label { font-size: 11px; color: var(--p-ink-3); text-transform: uppercase; letter-spacing: 0.5px; }
      .card-title { font-size: 13px; font-weight: 600; color: #5c3d00; }
      .card-desc  { font-size: 12px; color: #6f4b00; line-height: 1.5; }
      .card-value { font-size: 13px; color: var(--p-ink); }
      .card-value.ok { color: var(--p-accent-ink); }
      .profile-id { font-size: 12px; color: var(--p-ink-2); font-family: monospace; background: var(--p-surface-2); border-radius: 4px; padding: 6px 8px; word-break: break-all; }
      .profile-id + .profile-id { margin-top: 4px; }
      .profile-id-label { color: var(--p-ink-3); margin-right: 6px; font-family: var(--p-font-sans, inherit); }
      .usage-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--p-ink-2); }
      .usage-row-link { background: none; border: none; width: 100%; cursor: pointer; border-radius: 4px; padding: 2px 4px; margin: -2px -4px; transition: background 0.15s; font-family: inherit; }
      .usage-row-link:hover { background: var(--p-surface-2); color: var(--p-ink); }
      .usage-row-link:hover .usage-value { color: var(--p-accent-ink); }
      .usage-value { color: var(--p-ink); font-weight: 600; }
      .pin-unlock summary { font-size: 12px; color: var(--p-ink-3); cursor: pointer; }
      .pin-row { display: flex; gap: 6px; margin-top: 6px; }
      .pin-row input { flex: 1; background: var(--p-surface); border: 1px solid var(--p-rule); border-radius: 4px; color: var(--p-ink); font-size: 12px; padding: 6px 8px; outline: none; }
      .pin-row .btn { padding: 6px 10px; font-size: 12px; }
      .pin-error { font-size: 12px; color: #b91c1c; margin-top: 4px; }
      .toggle-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
      .toggle-row input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; accent-color: var(--p-accent); width: 14px; height: 14px; cursor: pointer; }
      .toggle-label { display: flex; flex-direction: column; gap: 2px; }
      .toggle-title { font-size: 12px; color: var(--p-ink); }
      .toggle-desc  { font-size: 11px; color: var(--p-ink-3); line-height: 1.45; }

      /* Loading overlay */
      .loading {
        position: absolute; inset: 0;
        background: rgba(230, 243, 234, 0.92);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 14px;
        /* Sit above the EQ thumbs (z-index:2) and publish-mode slider segs (z-index:1)
           which would otherwise poke through the saving/success/error veil. */
        z-index: 10;
      }
      .spinner {
        width: 44px; height: 44px;
        border: 4px solid var(--p-surface-2); border-top-color: var(--p-accent);
        border-radius: 50%; animation: spin 0.8s linear infinite;
      }
      .spinner-small {
        width: 16px; height: 16px;
        border: 2px solid var(--p-surface-2); border-top-color: var(--p-accent);
        border-radius: 50%; animation: spin 0.8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .loading p { color: var(--p-ink-2); font-size: 14px; }
      .success { color: var(--p-accent-ink); font-size: 18px; font-weight: 600; }
      .error   { color: #b91c1c; font-size: 18px; font-weight: 600; }
      .open-library-btn, .open-discernment-btn {
        margin-top: 10px; background: none; border: none; padding: 0;
        color: var(--p-accent-ink); font-size: 13px; cursor: pointer; text-decoration: underline;
      }
      .open-library-btn:hover, .open-discernment-btn:hover { color: var(--p-accent); }
      .dismiss-btn {
        margin-top: 8px; background: none; border: none; padding: 0;
        color: var(--p-ink-3); font-size: 12px; cursor: pointer; text-decoration: underline;
      }
      .dismiss-btn:hover { color: var(--p-ink); }
    `;
  }
}

// Register the custom element (guard against double-registration on re-injection)
try {
  if (!customElements.get('discerned-overlay')) {
    customElements.define('discerned-overlay', DiscernedOverlay);
  }
} catch { /* not a standard browsing context (iframe, worker, etc.) — skip registration */ }
