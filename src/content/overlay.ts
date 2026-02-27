// Role: Content Script — evaluation UI
// Description: Custom element (DiscernedOverlay) rendered inside a Shadow DOM to prevent
//              host-page style bleed. Three views: identity gate (first-run for guests),
//              inline NIP-46/nsec identity form, and the evaluation form (Clip / Cast).
//              Cast is gated behind identity — guests see a placeholder that opens the identity form.
// Access: Shadow DOM (ShadowRoot); chrome.runtime.sendMessage for auth connect and nudge-dismiss;
//         Clip/Cast actions delegated via callbacks

import type { AuthState, CaptureResult, Evaluation, InterestLevel, EthicsLevel, Category } from '@/shared/types';

export class DiscernedOverlay extends HTMLElement {
  private shadow: ShadowRoot;
  private capture: CaptureResult | null = null;
  private onClip: ((evaluation: Evaluation) => Promise<void>) | null = null;
  private onCast: ((evaluation: Evaluation) => Promise<void>) | null = null;
  private customCategories: string[] = [];
  private authState: AuthState = { type: 'guest' };
  // Which view is currently rendered
  private view: 'gate' | 'identity' | 'main' = 'main';
  // When navigating to identity from clip-only mode, back returns to main rather than gate
  private identityBackTarget: 'gate' | 'main' = 'gate';

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'closed' });
  }

  /**
   * Stop all pointer/keyboard events from propagating beyond the host element
   * into the page's light DOM. This runs in the bubble phase at the exact point
   * where composed events exit the shadow DOM, catching any that slipped past
   * the backdrop-level stoppers (e.g. when the shadow DOM re-renders mid-interaction).
   */
  connectedCallback() {
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      this.addEventListener(type, stop);
    }
  }

  /**
   * Show the overlay with captured data.
   * Guests who haven't dismissed the gate see it first; everyone else goes straight to the evaluation form.
   */
  show(
    capture: CaptureResult,
    callbacks: { onClip: (evaluation: Evaluation) => Promise<void>; onCast: (evaluation: Evaluation) => Promise<void> },
    authState: AuthState = { type: 'guest' },
    nudgeDismissed: boolean = false,
  ) {
    this.capture = capture;
    this.onClip = callbacks.onClip;
    this.onCast = callbacks.onCast;
    this.authState = authState;
    this.view = authState.type === 'guest' && !nudgeDismissed ? 'gate' : 'main';
    this.render();
  }

  hide() {
    this.remove();
  }

  private render() {
    switch (this.view) {
      case 'gate':     this.renderGate();     break;
      case 'identity': this.renderIdentity(); break;
      case 'main':     this.renderMain();     break;
    }
    this.blockHostPageEvents();
  }

  /**
   * Prevent all pointer and keyboard events from bubbling out of the shadow root
   * into the host page. Without this, sites that use event delegation on document/window
   * can intercept clicks inside the overlay (e.g. opening new tabs).
   */
  private blockHostPageEvents() {
    const backdrop = this.shadow.querySelector('.discerned-backdrop');
    if (!backdrop) return;
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      backdrop.addEventListener(type, stop);
    }
  }

  // ── Gate view ──────────────────────────────────────────────────────────────
  // Shown the first time a guest opens the overlay (nudge not yet dismissed).

  private renderGate() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-backdrop">
        <div class="discerned-modal">
          <div class="modal-header">
            <h2>📡 Discerned</h2>
            <button class="close-btn" id="close">×</button>
          </div>
          <div class="modal-body gate-body">
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
      chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_NUDGE' }).catch(() => {});
    });

    this.shadow.querySelector('.discerned-backdrop')?.addEventListener('click', (e) => {
      if (e.target === this.shadow.querySelector('.discerned-backdrop')) this.hide();
    });
  }

  // ── Identity view ──────────────────────────────────────────────────────────
  // Inline NIP-46 (email/bunker) and nsec import. Reachable from the gate or from
  // the "Connect to Cast" button in clip-only mode.

  private renderIdentity() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-backdrop">
        <div class="discerned-modal">
          <div class="modal-header identity-header">
            <button class="back-btn-header" id="identity-back" aria-label="Back">←</button>
            <h2>Connect identity</h2>
            <button class="close-btn" id="close">×</button>
          </div>
          <div class="modal-body identity-body">
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
      </div>
    `;

    this.attachIdentityListeners();
  }

  private attachIdentityListeners() {
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());

    this.shadow.getElementById('identity-back')?.addEventListener('click', () => {
      this.view = this.identityBackTarget;
      this.render();
    });

    // Tab switching — 3 tabs
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

    // NIP-07 detection
    this.shadow.getElementById('btn-detect-nip07')?.addEventListener('click', async () => {
      const status = this.shadow.getElementById('nip07-status');
      const btn    = this.shadow.getElementById('btn-detect-nip07') as HTMLButtonElement | null;
      this.setIdentityStatus(status, 'Checking…', 'spin');
      if (btn) btn.disabled = true;

      const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
      if (btn) btn.disabled = false;

      if (res?.success && res.data?.type === 'pro') {
        this.setIdentityStatus(status, 'Extension detected — you\'re connected!', 'ok');
        setTimeout(() => this.hide(), 1200);
      } else {
        this.setIdentityStatus(
          status,
          'No extension found. Install Alby or nos2x, visit any page, then try again.',
          'error',
        );
      }
    });

    // NIP-46 connect
    this.shadow.getElementById('btn-connect-nip46')?.addEventListener('click', async () => {
      const input  = this.shadow.getElementById('bunker-input') as HTMLTextAreaElement | null;
      const status = this.shadow.getElementById('nip46-status');
      const btn    = this.shadow.getElementById('btn-connect-nip46') as HTMLButtonElement | null;
      const bunkerUri = input?.value.trim() ?? '';

      if (!bunkerUri) {
        this.setIdentityStatus(status, 'Paste your bunker:// link first.', 'error');
        return;
      }
      this.setIdentityStatus(status, 'Connecting…', 'spin');
      if (btn) btn.disabled = true;

      const res = await chrome.runtime.sendMessage({ type: 'CONNECT_NIP46', bunkerUri });
      if (btn) btn.disabled = false;

      if (res.success) {
        this.setIdentityStatus(status, 'Connected!', 'ok');
        setTimeout(() => this.hide(), 1200);
      } else {
        this.setIdentityStatus(status, res.error ?? 'Connection failed. Check the link and try again.', 'error');
      }
    });

    // nsec import
    this.shadow.getElementById('btn-save-nsec')?.addEventListener('click', async () => {
      const nsecEl       = this.shadow.getElementById('nsec-input')  as HTMLTextAreaElement | null;
      const pinEl        = this.shadow.getElementById('pin-input')    as HTMLInputElement   | null;
      const pinConfirmEl = this.shadow.getElementById('pin-confirm')  as HTMLInputElement   | null;
      const status = this.shadow.getElementById('nsec-status');
      const btn    = this.shadow.getElementById('btn-save-nsec') as HTMLButtonElement | null;

      const rawNsec    = nsecEl?.value.trim() ?? '';
      const pin        = pinEl?.value ?? '';
      const pinConfirm = pinConfirmEl?.value ?? '';

      if (!rawNsec.startsWith('nsec1')) {
        this.setIdentityStatus(status, 'Invalid key — must start with nsec1…', 'error');
        return;
      }
      if (pin.length < 6) {
        this.setIdentityStatus(status, 'PIN must be at least 6 characters.', 'error');
        return;
      }
      if (pin !== pinConfirm) {
        this.setIdentityStatus(status, 'PINs don\'t match.', 'error');
        return;
      }
      this.setIdentityStatus(status, 'Encrypting…', 'spin');
      if (btn) btn.disabled = true;

      const res = await chrome.runtime.sendMessage({ type: 'CONNECT_NSEC', rawNsec, pin });
      if (btn) btn.disabled = false;

      if (res.success) {
        this.setIdentityStatus(status, 'Saved!', 'ok');
        setTimeout(() => this.hide(), 1200);
      } else {
        this.setIdentityStatus(status, res.error ?? 'Failed to save key. Please try again.', 'error');
      }
    });

    this.shadow.querySelector('.discerned-backdrop')?.addEventListener('click', (e) => {
      if (e.target === this.shadow.querySelector('.discerned-backdrop')) this.hide();
    });
  }

  private setIdentityStatus(el: Element | null, text: string, kind: 'error' | 'ok' | 'spin') {
    if (!el) return;
    el.className = `identity-status ${kind}`;
    if (kind === 'spin') {
      el.innerHTML = `<span class="spinner-inline"></span>${text}`;
    } else {
      el.textContent = text;
    }
  }

  // ── Main (evaluation) view ─────────────────────────────────────────────────
  // Shown for authenticated users and for guests in clip-only mode.
  // In clip-only mode the Cast button is replaced by a "Connect to Cast" placeholder.

  private renderMain() {
    if (!this.capture) return;

    const isConnected = this.authState.type !== 'guest';

    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-backdrop">
        <div class="discerned-modal">
          <div class="modal-header">
            <h2>📡 Discerned</h2>
            <button class="close-btn" id="close">×</button>
          </div>

          <div class="modal-body">
            <div class="capture-preview">
              ${this.renderCapturePreview()}
            </div>

            <div class="evaluation-form">
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
          </div>

          <div class="modal-footer">
            <div class="footer-meta">
              <div class="nostr-status">
                <span class="status-dot${isConnected ? ' connected' : ''}"></span>
                <span class="status-text">${isConnected ? 'Connected to Nostr' : 'Local only'}</span>
                ${!isConnected ? '<button class="nostr-signup-link" id="nostr-signup-link">Connect →</button>' : ''}
              </div>
              <label class="keep-private-label">
                <input type="checkbox" id="keep-private"${!isConnected ? ' checked' : ''} />
                <span>Keep private</span>
              </label>
            </div>
            <button class="btn btn-clip" id="clip" disabled>
              <span class="icon" id="clip-icon">${isConnected ? '📡' : '🔒'}</span>
              <span class="label">CLIP</span>
              <span class="sublabel" id="clip-sublabel">${isConnected ? 'Clip & broadcast' : 'Private storage'}</span>
            </button>
          </div>

          <div class="loading" id="loading" style="display: none;">
            <div class="spinner"></div>
            <p>Saving...</p>
          </div>
        </div>
      </div>
    `;

    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());

    const keepPrivateEl = this.shadow.getElementById('keep-private') as HTMLInputElement | null;
    const clipIconEl = this.shadow.getElementById('clip-icon');
    const clipSublabelEl = this.shadow.getElementById('clip-sublabel');

    const updateClipAppearance = () => {
      const keepPrivate = keepPrivateEl?.checked ?? true;
      const broadcastMode = !keepPrivate && isConnected;
      if (clipIconEl) clipIconEl.textContent = broadcastMode ? '📡' : '🔒';
      if (clipSublabelEl) clipSublabelEl.textContent = broadcastMode ? 'Clip & broadcast' : 'Private storage';
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

    this.shadow.querySelector('.discerned-backdrop')?.addEventListener('click', (e) => {
      if (e.target === this.shadow.querySelector('.discerned-backdrop')) this.hide();
    });

    this.validateForm();
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /**
   * Escape a plain string for safe insertion into HTML content or attributes.
   */
  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private renderCapturePreview(): string {
    if (!this.capture) return '';

    if (this.capture.type === 'quote') {
      // Extract plain text for length-safe truncation — slicing innerHTML at a
      // character boundary can split a tag and produce malformed markup.
      const tmp = document.createElement('div');
      tmp.innerHTML = this.capture.content;
      const text = tmp.textContent ?? '';
      const preview = text.length > 200
        ? this.escapeHtml(text.substring(0, 200)) + '...'
        : this.escapeHtml(text);
      return `
        <div class="quote-preview">
          <div class="quote-content">${preview}</div>
          <div class="quote-url">${this.escapeHtml(this.capture.url)}</div>
        </div>
      `;
    } else {
      return `
        <div class="resource-preview">
          ${this.capture.thumbnail ? `<img src="${this.escapeHtml(this.capture.thumbnail)}" alt="Thumbnail" />` : ''}
          <div class="resource-title">${this.escapeHtml(this.capture.title)}</div>
          <div class="resource-url">${this.escapeHtml(this.capture.url)}</div>
        </div>
      `;
    }
  }

  private setupCategoryCombobox() {
    const input  = this.shadow.getElementById('category')       as HTMLInputElement;
    const toggle = this.shadow.getElementById('category-toggle') as HTMLButtonElement;
    const list   = this.shadow.getElementById('category-list')   as HTMLUListElement;
    if (!input || !toggle || !list) return;

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
        li => li.dataset.value?.toLowerCase() === trimmed.toLowerCase()
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
      if (list.classList.contains('open')) {
        closeList();
      } else {
        openList();
        input.focus();
      }
    });

    list.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => selectValue(li.dataset.value ?? li.textContent ?? ''));
    });

    input.addEventListener('input', () => this.validateForm());
    input.addEventListener('blur', () => { addCustomIfNew(input.value); closeList(); });
  }

  private validateForm() {
    const interest = (this.shadow.getElementById('interest') as HTMLSelectElement | null)?.value;
    const ethics   = (this.shadow.getElementById('ethics')   as HTMLSelectElement | null)?.value;
    const category = (this.shadow.getElementById('category') as HTMLInputElement  | null)?.value.trim();

    const isValid = !!(interest && ethics && category);

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
    const keepPrivateEl = this.shadow.getElementById('keep-private') as HTMLInputElement | null;
    const keepPrivate = keepPrivateEl?.checked ?? true;
    const isConnected = this.authState.type !== 'guest';
    const shouldBroadcast = !keepPrivate && isConnected;

    const evaluation = this.getEvaluation();
    this.showLoading('Saving...');
    try {
      await this.onClip?.(evaluation);
    } catch {
      this.showError('Failed to clip. Please try again.');
      return;
    }

    // Show success and close immediately — relay broadcast fires in the background
    // so relay latency never blocks the overlay UI.
    this.showSuccess(shouldBroadcast ? 'Clipped! 📡 Broadcasting...' : 'Clipped! 🔒');
    setTimeout(() => this.hide(), 1500);

    if (shouldBroadcast) {
      this.onCast?.(evaluation).catch((err: unknown) => {
        // Error is already user-visible via showCastErrorToast in content.ts handleCast.
        console.warn('Discerned: broadcast failed (clip already saved locally)',
          err instanceof Error ? err.message : err);
      });
    }
  }

  private showLoading(text: string = 'Saving...') {
    const loading = this.shadow.getElementById('loading');
    if (loading) {
      loading.style.display = 'flex';
      const p = loading.querySelector('p');
      if (p) p.textContent = text;
    }
  }

  private showSuccess(message: string) {
    const loading = this.shadow.getElementById('loading');
    if (loading) loading.innerHTML = `<div class="success">✓ ${message}</div>`;
  }

  private showError(message: string) {
    const loading = this.shadow.getElementById('loading');
    if (loading) {
      loading.innerHTML = `<div class="error">✗ ${message}</div>`;
      setTimeout(() => { if (loading) loading.style.display = 'none'; }, 2500);
    }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private getStyles(): string {
    return `
      :host { display: block; }

      * { margin: 0; padding: 0; box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

      /* Backdrop + modal */

      .discerned-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647;
        animation: fadeIn 0.2s ease;
      }

      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

      .discerned-modal {
        position: relative;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 12px;
        width: 90%; max-width: 500px; max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        animation: slideUp 0.3s ease;
      }

      @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

      /* Header */

      .modal-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 20px; border-bottom: 1px solid #333;
      }

      .identity-header { gap: 10px; }

      h2 { color: #fff; font-size: 20px; font-weight: 600; flex: 1; }
      .identity-header h2 { font-size: 16px; }

      .close-btn {
        background: none; border: none; color: #888;
        font-size: 28px; cursor: pointer; padding: 0;
        width: 32px; height: 32px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        border-radius: 4px; transition: all 0.2s;
      }
      .close-btn:hover { background: #333; color: #fff; }

      .back-btn-header {
        background: none; border: none; color: #888;
        font-size: 18px; cursor: pointer; padding: 4px 8px;
        border-radius: 4px; transition: color 0.2s; flex-shrink: 0;
      }
      .back-btn-header:hover { color: #e8e8e8; }

      /* ── Gate view ── */

      .gate-body {
        display: flex; flex-direction: column; align-items: center;
        text-align: center; padding: 32px 24px; gap: 16px;
      }

      .gate-icon { font-size: 40px; }

      .gate-title { font-size: 16px; font-weight: 600; color: #fff; }

      .gate-desc {
        font-size: 13px; color: #888; line-height: 1.6;
        max-width: 340px;
      }

      .gate-btn { width: 100%; max-width: 280px; margin-top: 4px; }

      /* ── Identity view ── */

      .identity-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; }

      .identity-tabs {
        display: flex; gap: 4px;
        border-bottom: 1px solid #333;
      }

      .tab-btn {
        background: none; border: none;
        border-bottom: 2px solid transparent;
        color: #888; font-size: 13px; font-weight: 600;
        padding: 8px 16px; cursor: pointer;
        transition: color 0.15s, border-color 0.15s;
        margin-bottom: -1px;
      }
      .tab-btn:hover { color: #e8e8e8; }
      .tab-btn.active { color: #0ea5e9; border-bottom-color: #0ea5e9; }

      .identity-panel { display: flex; flex-direction: column; gap: 10px; }

      .panel-desc { font-size: 12px; color: #888; line-height: 1.6; }
      .panel-desc a { color: #a78bfa; text-decoration: none; }
      .panel-desc a:hover { text-decoration: underline; }
      .panel-desc code {
        background: #252525; border: 1px solid #333; border-radius: 3px;
        padding: 1px 5px; font-size: 0.9em; color: #a78bfa;
      }

      .panel-warning {
        background: #2a1f00; border: 1px solid #6b4a00; border-radius: 6px;
        padding: 10px 12px; font-size: 12px; color: #f0c040; line-height: 1.5;
      }

      textarea {
        width: 100%; background: #252525; border: 1px solid #3a3a3a;
        border-radius: 6px; color: #e8e8e8;
        font-family: monospace; font-size: 12px;
        padding: 10px; resize: vertical; min-height: 60px;
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

      .identity-status {
        font-size: 12px; min-height: 16px;
        display: flex; align-items: center; gap: 6px;
      }
      .identity-status.error { color: #f87171; }
      .identity-status.ok    { color: #4ade80; }
      .identity-status.spin  { color: #a78bfa; }

      .spinner-inline {
        display: inline-block; width: 12px; height: 12px; flex-shrink: 0;
        border: 2px solid #555; border-top-color: #a78bfa;
        border-radius: 50%; animation: spin 0.7s linear infinite;
      }

      /* ── Main (evaluation) view ── */

      .modal-body { padding: 20px; }

      .capture-preview {
        margin-bottom: 24px; padding: 16px;
        background: #252525; border-radius: 8px; border-left: 4px solid #0ea5e9;
      }

      .quote-content { color: #e5e5e5; font-size: 14px; line-height: 1.6; margin-bottom: 8px; }
      .quote-url, .resource-url { color: #888; font-size: 12px; word-break: break-all; }

      .resource-preview img {
        width: 100%; height: 120px; object-fit: cover;
        border-radius: 6px; margin-bottom: 12px;
      }
      .resource-title { color: #fff; font-size: 16px; font-weight: 500; margin-bottom: 8px; }

      .evaluation-form { display: flex; flex-direction: row; gap: 10px; align-items: flex-start; }

      .form-group { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

      label {
        color: #aaa; font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
      }

      select {
        background: #2a2a2a; border: 1px solid #444; color: #fff;
        padding: 10px 8px; border-radius: 6px; font-size: 13px;
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
        padding: 10px 8px; border-radius: 6px 0 0 6px;
        font-size: 13px; font-family: inherit; transition: border-color 0.2s;
      }

      .combobox-toggle {
        background: #2a2a2a; border: 1px solid #444; border-left: none;
        color: #888; padding: 0 9px; border-radius: 0 6px 6px 0;
        cursor: pointer; font-size: 12px; flex-shrink: 0; transition: border-color 0.2s;
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
      .combobox-list li { padding: 8px 12px; color: #e5e5e5; font-size: 13px; cursor: pointer; font-family: inherit; }
      .combobox-list li:hover { background: #0ea5e9; color: #fff; }
      .combobox-list li.custom-entry { color: #aaa; font-style: italic; }

      /* Footer buttons */

      .modal-footer { padding: 20px; border-top: 1px solid #333; display: flex; flex-direction: column; gap: 12px; }

      .footer-meta { display: flex; align-items: center; justify-content: space-between; }

      .nostr-status { display: flex; align-items: center; gap: 6px; }

      .status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #555; flex-shrink: 0;
      }
      .status-dot.connected { background: #22c55e; }

      .status-text { font-size: 11px; color: #888; }

      .nostr-signup-link {
        background: none; border: none; color: #0ea5e9;
        font-size: 11px; cursor: pointer; padding: 0 0 0 6px;
        text-decoration: underline; font-family: inherit; line-height: 1;
      }
      .nostr-signup-link:hover { color: #38bdf8; }

      .keep-private-label {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; color: #aaa; cursor: pointer; user-select: none;
      }
      .keep-private-label input[type="checkbox"] {
        width: 14px; height: 14px; accent-color: #0ea5e9; cursor: pointer;
      }

      .btn {
        flex: 1; padding: 16px; border: none; border-radius: 8px;
        font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
      }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }

      .btn-secondary { background: #2a2a2a; color: #fff; border: 1px solid #444; }
      .btn-secondary:not(:disabled):hover { background: #333; }

      .btn-primary { background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #fff; }
      .btn-primary:not(:disabled):hover { background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); }

      .btn-clip {
        flex: none; width: 100%;
        background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: #fff;
      }
      .btn-clip:not(:disabled):hover { background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); }

      .btn-ghost { background: #252525; color: #888; border: 1px solid #333; }
      .btn-ghost:hover { background: #2a2a2a; color: #e8e8e8; }

      /* "Connect to Cast" placeholder button */
      .btn-cast-connect {
        flex: 1; padding: 16px;
        border: 1px dashed #444; border-radius: 8px;
        background: #1e1e1e; color: #555;
        cursor: pointer; transition: all 0.2s;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        font-size: 14px; font-weight: 600;
      }
      .btn-cast-connect:hover { border-color: #0ea5e9; color: #0ea5e9; background: #1a2a35; }

      .btn .icon, .btn-cast-connect .icon { font-size: 24px; }
      .btn .label, .btn-cast-connect .label { font-size: 14px; }
      .btn .sublabel, .btn-cast-connect .sublabel { font-size: 11px; opacity: 0.7; font-weight: 400; }

      /* Loading / success / error overlay */

      .loading {
        position: absolute; inset: 0;
        background: rgba(26,26,26,0.95);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 16px; border-radius: 12px;
      }

      .spinner {
        width: 48px; height: 48px;
        border: 4px solid #333; border-top-color: #0ea5e9;
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
