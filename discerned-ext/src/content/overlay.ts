// Role: Content Script — Evernote-style left-side clipper panel
// Description: Custom element (DiscernedOverlay) rendered inside a Shadow DOM. Fixed left-side
//              panel (380px wide, full-height) with five clip formats, a notes textarea, an
//              evaluation form, and an inline settings drawer (auth state + stats + export).
//              When format='article', a live on-page rectangle outlines the detected article
//              container via the highlighter module.
// Access: Shadow DOM (ShadowRoot); chrome.runtime.sendMessage for auth + stats; on-page DOM
//         (only for the article highlight rectangle, drawn into document.body).

import type { AuthState, Capture, ClipFormat, Evaluation, SignalLevel, Category, PublishMode, Theme, ResolvedTheme, OwnProfile } from '@/shared/types';
import { detectAuthState } from '@/shared/nostr/auth';
import { STORAGE_KEYS, SIGNAL_LEVELS, SIGNAL_DESCRIPTIONS, QUALIFIER_GROUPS, signalRank, resolveRelayMode, resolveThemePref, resolveEffectiveTheme } from '@/shared/types';
import { getEffectiveRelays } from '@/shared/relays';
import { themeVarsBlock, prefersDark, onSystemThemeChange } from '@/shared/theme';
import { LL, log } from '@/shared/logger';
import { CAST_INLINE_BODY_MAX_CHARS } from '@/shared/nostr/events';
import { showArticleHighlight, hideArticleHighlight } from './highlighter';
import { npubEncode } from 'nostr-tools/nip19';

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

/** ID stamped on the host <div> so capture.ts and nip07-bridge.ts can find/skip the overlay. */
export const OVERLAY_HOST_ID = 'discerned-overlay';

/**
 * Sticky "show developer options" flag, armed by Alt-clicking the ⚙ gear.
 *
 * Module scope, NOT an instance field: content.ts builds a fresh
 * DiscernedOverlay on every activation, so per-instance state dies the moment
 * the overlay closes and the user would have to hold Alt every single time.
 * Lives as long as the content script does — i.e. until the page navigates or
 * reloads, which is the "session" the user sees.
 *
 * One-way latch: Alt-clicking arms it, and an ordinary click thereafter leaves
 * it armed. Reload the page to clear it.
 */
let devOptionsUnlocked = false;

/**
 * The overlay was originally a Custom Element (`<discerned-overlay>`) but
 * `window.customElements` is null in content-script isolated worlds on at
 * least Chromium and Brave for some pages, which makes `customElements.define`
 * throw and `new (X extends HTMLElement)` fail with "Illegal constructor."
 *
 * We host the shadow root on a plain `<div id="discerned-overlay">` instead.
 * Same shadow DOM, same panel UI; no registry dependency.
 */
export class DiscernedOverlay {
  readonly host: HTMLDivElement;
  private shadow: ShadowRoot;
  private opts: OverlayShowOptions | null = null;
  private capture: Capture | null = null;
  private format: ClipFormat = 'article';
  private hasSelection = false;
  private note = '';
  private customCategories: string[] = [];
  private authState: AuthState = { type: 'guest' };
  // Kind-0 profile (name / verified nip05) for the signed-in identity, fetched
  // once per show() and shared by the settings identity block + footer tooltip.
  private ownProfile: OwnProfile | null = null;
  private view: View = 'main';
  private identityBackTarget: View = 'main';
  private identityStep: 'choose' | 'existing' | 'create' = 'choose';
  private initialConnectTab: 'nip07' | 'nip46' | 'nsec' = 'nip07';
  private generatedNsec: string | null = null;
  private generatedNpub: string | null = null;
  private captureGeneration = 0;
  private capturing = false;
  private publishMode: PublishMode = 'both';
  // Signal + qualifiers open UNRATED every capture (no sticky defaults) —
  // an untouched form saves as unrated. Category alone stays last-used.
  private signal: SignalLevel | null = null;
  private selectedQualifiers = new Set<string>();
  private customQualifiers: string[] = [];
  private category: Category = 'General';
  private previewHost: HTMLElement | null = null;
  private previewShadow: ShadowRoot | null = null;
  private outsideClickHandler: ((e: PointerEvent) => void) | null = null;
  // The panel's slide-in animation should play only on the FIRST render. show()
  // renders once immediately, then re-renders after async storage loads — without
  // this guard the panel visibly slides in twice (most noticeable on slow /
  // heavily-mutating pages like ad-dense articles).
  private hasRendered = false;
  private mountObserver: MutationObserver | null = null;
  private authStorageListener: Parameters<typeof chrome.storage.onChanged.addListener>[0] | null = null;
  // Theme: stored preference ('system'|'light'|'dark') + the theme actually applied.
  // effectiveTheme is resolved provisionally from the OS at construction so the first
  // synchronous render is correct for default ('system') users, then reconciled against
  // stored preference in show(). themeSystemUnsub tears down the matchMedia listener.
  private themePref: Theme = 'system';
  private effectiveTheme: ResolvedTheme = 'dark';
  private themeSystemUnsub: (() => void) | null = null;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = OVERLAY_HOST_ID;
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    this.effectiveTheme = resolveEffectiveTheme('system', prefersDark());

    // Stop pointer/keyboard events propagating from the panel into the host page
    // so sites with document-level event delegation don't intercept clicks inside us.
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      this.host.addEventListener(type, stop);
    }

    this.outsideClickHandler = (e: PointerEvent) => {
      // Only a REAL user click dismisses the overlay. `isTrusted` is false for
      // any event a page dispatches itself, and a page-dispatched pointerdown
      // should never be able to throw away an evaluation the user is part-way
      // through — hide() is destructive (it drops the typed note and rating).
      //
      // Hardening only. The sporadic MSN/Bloomberg dismissal turned out to be
      // an inherited `pointer-events: none` (see getStyles()), not this.
      if (!e.isTrusted) return;
      if (!e.composedPath().includes(this.host) && !this.previewHost?.contains(e.target as Node)) this.hide();
    };
    document.addEventListener('pointerdown', this.outsideClickHandler);

    // Mirror the old disconnectedCallback: if the host gets removed by anything
    // other than our hide(), tear down the document-level listener and chrome.
    this.mountObserver = new MutationObserver(() => {
      if (!this.host.isConnected) this.teardown();
    });
    this.mountObserver.observe(document.body, { childList: true, subtree: true });
  }

  private teardown(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('pointerdown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    if (this.mountObserver) {
      this.mountObserver.disconnect();
      this.mountObserver = null;
    }
    if (this.authStorageListener) {
      chrome.storage.onChanged.removeListener(this.authStorageListener);
      this.authStorageListener = null;
    }
    if (this.themeSystemUnsub) {
      this.themeSystemUnsub();
      this.themeSystemUnsub = null;
    }
    hideArticleHighlight();
    this.removePreview();
  }

  /** Update the stored-preference + resolved-theme pair (does not render). */
  private applyThemePref(pref: Theme): void {
    this.themePref = pref;
    this.effectiveTheme = resolveEffectiveTheme(pref, prefersDark());
  }

  async show(options: OverlayShowOptions): Promise<void> {
    this.opts = options;
    this.format = options.initialFormat;
    this.hasSelection = options.hasSelection;
    this.authState = options.authState;
    this.ownProfile = null; // re-fetched per show() by loadOwnProfile

    // Refresh authState + re-render when the background persists a change
    // (e.g. user completed web-app sign-in in another tab → pubkey arrives), and
    // restyle live when the theme preference changes (e.g. via the Appearance
    // picker in this or another surface). The overlay can stay open for minutes.
    this.authStorageListener = (changes, area) => {
      if (area !== 'local') return;
      const next = changes[STORAGE_KEYS.AUTH_STATE]?.newValue as AuthState | undefined;
      if (next) {
        // Drop a cached profile whose identity no longer matches (switch / disconnect).
        const nextPubkey = next.type === 'guest' ? undefined : next.pubkey;
        if (this.ownProfile && this.ownProfile.pubkey !== nextPubkey) this.ownProfile = null;
        this.authState = next;
        this.render();
      }
      if (STORAGE_KEYS.THEME in changes) {
        // Always re-render on a theme write: styles may change, and the Settings
        // Appearance picker's active chip must move even when effectiveTheme is unchanged.
        this.applyThemePref(resolveThemePref(changes[STORAGE_KEYS.THEME]?.newValue as string | undefined));
        this.render();
      }
    };
    chrome.storage.onChanged.addListener(this.authStorageListener);

    // Follow OS light/dark changes while the preference is 'system'.
    this.themeSystemUnsub = onSystemThemeChange(() => {
      if (this.themePref !== 'system') return;
      const prev = this.effectiveTheme;
      this.effectiveTheme = resolveEffectiveTheme('system', prefersDark());
      if (this.effectiveTheme !== prev) this.render();
    });

    // Load the stored theme preference and reconcile (provisional value was set
    // from the OS at construction — no re-render unless the resolved theme differs).
    void chrome.storage.local.get(STORAGE_KEYS.THEME).then((s) => {
      const prev = this.effectiveTheme;
      this.applyThemePref(resolveThemePref(s[STORAGE_KEYS.THEME] as string | undefined));
      if (this.effectiveTheme !== prev) this.render();
    }).catch(() => { /* keep provisional theme */ });

    const needsConnectPrompt =
      options.authState.type === 'guest' ||
      (options.authState.type === 'pro' && !options.authState.pubkey);
    this.view = needsConnectPrompt && !options.nudgeDismissed ? 'gate' : 'main';
    this.note = '';
    // Always open unrated — capturing without touching the form saves as unrated.
    this.signal = null;
    this.selectedQualifiers.clear();
    // Initial render immediately so the user sees the panel chrome, then
    // load persisted evaluation defaults and re-render main (if needed).
    this.render();

    // Load persisted publish mode + evaluation defaults, then patch the main view.
    // Done after the first render so the panel appears instantly with no async delay.
    void (async () => {
      try {
        const stored = await chrome.storage.local.get([
          STORAGE_KEYS.LAST_PUBLISH_MODE, STORAGE_KEYS.LAST_CATEGORY,
        ]);
        const validModes: PublishMode[] = ['cast', 'local', 'both'];
        const m = stored[STORAGE_KEYS.LAST_PUBLISH_MODE] as string | undefined;
        if (m && (validModes as string[]).includes(m)) this.publishMode = m as PublishMode;

        const sc = stored[STORAGE_KEYS.LAST_CATEGORY] as string | undefined;
        if (sc?.trim()) this.category = sc.trim();
      } catch { /* non-fatal; use defaults */ }

      try {
        const catStored = await chrome.storage.local.get([STORAGE_KEYS.CATEGORIES, STORAGE_KEYS.QUALIFIERS]);
        const persisted = (catStored[STORAGE_KEYS.CATEGORIES] as string[] | undefined) ?? [];
        this.customCategories = persisted.length > 0 ? persisted : this.customCategories;
        this.customQualifiers = (catStored[STORAGE_KEYS.QUALIFIERS] as string[] | undefined) ?? [];
      } catch { /* non-fatal; categories stay in-memory */ }

      if (!this.isConnected()) this.publishMode = 'local';

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
    this.teardown();
    this.host.remove();
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
        'z-index:2147483646;display:block;max-width:320px;' +
        // Escape an inherited `pointer-events:none` from a paywall/interstitial
        // that froze the page (see the :host rule in getStyles()). The preview
        // is a separate body-child host, so it inherits independently.
        'pointer-events:auto;';
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
    // The preview card is its OWN (closed) shadow root, so it can't inherit the
    // panel's :host tokens — it gets its own token block for the active theme.
    shadow.innerHTML = `
      <style>
        :host {
${themeVarsBlock(this.effectiveTheme)}
        }
        * { margin:0; padding:0; box-sizing:border-box;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        .preview-card {
          background:var(--p-card); border:1px solid var(--p-rule); border-left:4px solid var(--p-accent);
          padding:14px; display:flex; flex-direction:column; gap:8px;
          box-shadow:4px 4px 20px var(--p-cta-shadow);
          animation:fadeIn .18s ease-out;
          user-select:text; cursor:text;
        }
        /* Rebuilt on every render (theme changes restyle this separate shadow
           root), so replay the entry animation only on the card's first build. */
        :host(.no-anim) .preview-card { animation:none; }
        @keyframes fadeIn { from { opacity:0; transform:translateX(-6px); } to { opacity:1; transform:none; } }
        .preview-label {
          font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:var(--p-accent);
          font-family:var(--p-mono);
        }
        .preview-thumb {
          max-width:100%; max-height:120px; width:auto; height:auto; object-fit:contain; align-self:flex-start;
        }
        .preview-title { color:var(--p-ink); font-size:13px; font-weight:600; line-height:1.4; }
        .preview-text  { color:var(--p-ink-3); font-size:12px; line-height:1.55; white-space:pre-wrap; }
        .preview-url   { color:var(--p-ink-4); font-size:11px; word-break:break-all; }
        .preview-loading { display:flex; align-items:center; gap:8px; color:var(--p-ink-3); font-size:12px; }
        .spinner {
          width:14px; height:14px; flex-shrink:0;
          border:2px solid var(--p-rule); border-top-color:var(--p-accent);
          border-radius:50%; animation:spin .8s linear infinite;
        }
        @keyframes spin { to { transform:rotate(360deg); } }
      </style>
      ${this.renderPreviewContent()}
    `;
    // Suppress the fade-in on subsequent rebuilds (same rationale as the panel's
    // no-anim guard in render()) — the card must not re-animate on a theme change.
    this.previewHost!.classList.add('no-anim');
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
    // Suppress the slide-in animation on every render after the first, so async
    // re-renders during show() don't replay it (the "slides in twice" glitch).
    if (this.hasRendered) {
      this.shadow.querySelector('.discerned-root')?.classList.add('no-anim');
    }
    this.hasRendered = true;
    this.blockHostPageEvents();
    this.applyHighlightForCurrentFormat();
    // The preview card lives in its OWN closed shadow root outside the panel, so
    // re-rendering the panel can't restyle it. Refresh it here or a theme change
    // leaves it on the previous theme's tokens until the next capture/format click.
    this.updatePreview();
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
    const signerDetected = this.authState.type === 'pro' && !this.authState.pubkey;
    const icon = signerDetected ? '🔑' : '🔒';
    const title = signerDetected ? "You're one click from publishing" : 'Start local, publish when ready';
    // "Stays on this device" is literal — clips are NOT encrypted at rest (the
    // IndexedDB row's `encrypted` field holds plaintext JSON; NIP-44 is stubbed),
    // so nothing here may imply encryption.
    const desc = signerDetected
      ? `Your Nostr signing extension is ready. Sign in to publish your discerns under your own
         identity — they'll appear in any Nostr client, to the people who already follow you.`
      : `Clip what's worth reading, rate it, and build a library of high-quality information. It
         all stays on this device. Connect a Nostr identity to publish as you go — your ratings
         stay yours, on an open network no company controls.`;
    const primaryLabel = signerDetected ? 'Sign in →' : 'Connect a Nostr identity →';

    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="discerned-root panel">
        <header class="panel-header">
          <h2>${DiscernedOverlay.BRAND_MARK} Discerned</h2>
          <div class="header-actions">
            <button class="icon-btn close-btn" id="close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="panel-body gate-body">
          <div class="gate-icon">${icon}</div>
          <p class="gate-title">${title}</p>
          <p class="gate-desc">${desc}</p>
          <button class="btn btn-primary gate-btn" id="gate-connect">${primaryLabel}</button>
          <button class="btn btn-ghost gate-btn" id="gate-clip-only">Not now — keep clips on this device</button>
        </div>
      </div>
    `;
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('gate-connect')?.addEventListener('click', () => {
      if (signerDetected) {
        // Skip the chooser — open the web-app sign-in tab directly. Dismiss
        // the nudge so we don't re-prompt on every activation while the user
        // is finishing sign-in on the web app.
        void chrome.runtime.sendMessage({ type: 'OPEN_HOME', autoSignin: true });
        void chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_NUDGE' });
        this.view = 'main';
        this.render();
        void this.refreshCapture();
      } else {
        this.identityBackTarget = 'gate';
        this.identityStep = 'choose';
        this.view = 'identity';
        this.render();
      }
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
    const signerDetected = this.authState.type === 'pro' && !this.authState.pubkey;
    const signinCard = signerDetected ? `
          <button class="choice-card" id="choice-signin" type="button">
            <div class="choice-title">Sign in →</div>
            <div class="choice-desc">Signing extension detected. Sign in to Discerned to start casting.</div>
          </button>
    ` : '';

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
          ${signinCard}
          <button class="choice-card" id="choice-existing" type="button">
            <div class="choice-title">Connect existing identity →</div>
            <div class="choice-desc">Already on Nostr? Use a signing extension, remote signer, or your private key.</div>
          </button>
          <button class="choice-card" id="choice-create" type="button">
            <div class="choice-title">Create new Nostr account →</div>
            <div class="choice-desc">New to Nostr? Get set up with a guided walkthrough at nstart.me.</div>
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
    this.shadow.getElementById('choice-signin')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'OPEN_HOME', autoSignin: true });
      void chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_NUDGE' });
      this.view = 'main';
      this.render();
      void this.refreshCapture();
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

  /**
   * "Create new Nostr account" step — hand the user off to nstart.me rather than
   * minting a keypair here. nstart walks newcomers through what Nostr is, backup,
   * and a profile, which a bare "here are two long strings" screen can't. It ends
   * with either a bunker:// link (its default) or an nsec, so this screen offers a
   * route back for both. The in-house generator (GENERATE_NSEC / renderKeyBackup)
   * is deliberately kept in the codebase, just no longer reachable from the UI.
   */
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
            New to Nostr? <a href="https://nstart.me" target="_blank" rel="noopener noreferrer">nstart.me</a>
            is a free guided setup that explains how Nostr works, creates your identity,
            and helps you back it up safely. It takes a couple of minutes.
          </p>
          <button class="btn btn-primary" id="btn-open-nstart" type="button">Create account at nstart.me →</button>
          <p class="panel-desc">
            Once you're done, come back here and connect the identity you just made —
            whichever way nstart set you up: a signing extension, a <code>bunker://</code>
            link, or your <code>nsec</code>.
          </p>
          <button class="btn btn-secondary" id="btn-connect-after-nstart" type="button">I've created my account — connect it</button>
          <p class="identity-status" id="create-status"></p>
        </div>
      </div>
    `;
    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('identity-back')?.addEventListener('click', () => {
      this.identityStep = 'choose';
      this.render();
    });
    // Content scripts have no chrome.tabs — the anchor above is the actual opener;
    // the button mirrors it for users who reach for the primary action first.
    this.shadow.getElementById('btn-open-nstart')?.addEventListener('click', () => {
      window.open('https://nstart.me', '_blank', 'noopener,noreferrer');
    });
    this.shadow.getElementById('btn-connect-after-nstart')?.addEventListener('click', async () => {
      // nstart can finish by installing a signing extension. If the user did that
      // while away, cached auth state doesn't know yet — probe the live page for
      // window.nostr first (same reason as btn-detect-nip07), then land on the tab
      // that matches how they were actually set up. Falls back to bunker://,
      // nstart's default hand-off.
      const probed = await detectAuthState().catch(() => null);
      if (probed?.type === 'pro') {
        await chrome.runtime.sendMessage({ type: 'NIP07_DETECTED', hasNIP07: true }).catch(() => { /* non-fatal */ });
        const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }).catch(() => null);
        if (res?.success && res.data) this.authState = res.data as AuthState;
      }
      this.identityStep = 'existing';
      this.initialConnectTab = this.authState.type === 'pro' ? 'nip07' : 'nip46';
      this.render();
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

    const nip07HasPubkey = this.authState.type === 'pro' && !!this.authState.pubkey;
    const nip07Panel = nip07HasPubkey
      ? `
            <p class="identity-status ok"><span class="status-dot ok"></span>Signing extension connected.</p>
            <p class="panel-desc">Discerned uses your browser signing extension to sign casts. No key is stored here.</p>
            <button class="btn btn-primary" id="btn-use-nip07" type="button">Continue</button>
            <p class="identity-status" id="nip07-status"></p>
          `
      : nip07Detected
      ? `
            <p class="identity-status ok"><span class="status-dot ok"></span>Signing extension detected.</p>
            <p class="panel-desc">
              To finish connecting, sign in to Discerned. This is one time only — your signing extension
              will then be used to sign casts. No key is stored here.
            </p>
            <button class="btn btn-primary" id="btn-signin-nip07" type="button">Sign in →</button>
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
              If you already use a remote signer, paste its <code>bunker://</code> link below.
              Your private key never leaves the signer — Discerned only sends it events to sign.
            </p>
            <p class="panel-desc">
              Don't have one yet? You can create an account at
              <a href="https://nstart.me" target="_blank" rel="noopener noreferrer">nstart.me</a>
              or other bunker signers, then copy the <code>bunker://</code> link it gives you.
              Setting up a signer is a separate step outside Discerned — if you don't end up with
              a link to paste, the Extension tab is easier and better supported.
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
      // Actually probe the live page for window.nostr (GET_AUTH_STATE alone only
      // reads cached background state, which is stale right after a disconnect).
      const probed = await detectAuthState().catch(() => null);
      // Report the negative too — this button is pressed exactly when the user
      // suspects the state is wrong, so it must clear a stale `pro` as well.
      await chrome.runtime.sendMessage({
        type: 'NIP07_DETECTED',
        hasNIP07: probed?.type === 'pro',
      }).catch(() => { /* non-fatal */ });
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

    // NIP-07 already detected AND we have a pubkey — "Continue" dismisses to main.
    this.shadow.getElementById('btn-use-nip07')?.addEventListener('click', () => {
      this.view = 'main';
      this.render();
      void this.refreshCapture();
    });

    // NIP-07 detected but no pubkey — kick off web-app sign-in. Dismiss the
    // overlay so the user can complete sign-in in the discerned tab; the
    // storage listener will refresh the cached auth state for next activation.
    this.shadow.getElementById('btn-signin-nip07')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'OPEN_HOME', autoSignin: true });
      void chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_NUDGE' });
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

  private renderSettings() {
    const ev = this.escapeHtml.bind(this);
    const auth = this.authState;
    const formatPubkey = (pk: string) => {
      try { const npub = npubEncode(pk); return `${npub.slice(0, 16)}…${npub.slice(-8)}`; } catch { return pk; }
    };
    // Primary name line (verified nip05 / display name) is patched in async by
    // loadOwnProfile() once the kind-0 profile resolves; the npub always stays
    // visible as the fallback + secondary identifier.
    const nameLine = (): string => {
      const p = this.ownProfile;
      const label = p?.verified && p.nip05 ? p.nip05 : (p?.name ?? '');
      const style = label ? '' : ' style="display:none"';
      return `<div class="profile-name" id="profile-name"${style}>${ev(label)}</div>`;
    };
    const identityBlock = (pk: string): string => {
      return `<div class="profile-identity">${nameLine()}<div class="profile-id"><span class="profile-id-label">npub:</span> ${ev(formatPubkey(pk))}</div></div>`;
    };

    let authBlock = '';
    if (auth.type === 'guest') {
      authBlock = `
        <div class="settings-card warning">
          <div class="card-title">Publishing not set up</div>
          <div class="card-desc">Your clips and ratings stay on this device. Connect a Nostr identity to publish them publicly.</div>
          <button class="btn btn-primary" id="settings-connect">Connect a Nostr identity →</button>
        </div>
      `;
    } else if (auth.type === 'pro') {
      // Two sub-states for NIP-07: we know a wallet is installed, but the
      // user hasn't completed Sign In on the discerned web app yet, so we
      // don't have their pubkey. Show a clearly different status until
      // Sign In completes — otherwise "Connected" misleads the user into
      // thinking casts will work, but the first cast routes through the
      // web-app confirm flow and fails if they never set things up.
      const statusValue = auth.pubkey
        ? '<div class="card-value ok">Connected via signing extension</div>'
        : '<div class="card-value">Signing extension detected — sign in to connect</div>';
      const noPubkeyCta = auth.pubkey ? '' : `
        <div class="card-desc" style="margin-top:8px">
          Sign in to connect your signing extension. You'll only be asked once.
        </div>
        <button class="btn btn-primary" id="settings-connect" style="margin-top:8px">Sign in →</button>
      `;
      // Only offer Disconnect once actually signed in (pubkey present). Without
      // a pubkey the wallet is merely *detected* — nothing has been connected to
      // disconnect from, and the MAIN view already treats this as "Local only".
      // Showing Disconnect here would contradict the main view and, since a
      // detected wallet re-promotes guest→pro on the next activation, the button
      // could never toggle away.
      const disconnectBtn = auth.pubkey
        ? '<button class="link-btn" id="settings-disconnect">Disconnect</button>'
        : '';
      authBlock = `
        <div class="settings-card">
          <div class="card-row">
            <div>
              <div class="card-label">Status</div>
              ${statusValue}
            </div>
            ${disconnectBtn}
          </div>
          ${auth.pubkey ? identityBlock(auth.pubkey) : noPubkeyCta}
        </div>
      `;
    } else if (auth.type === 'nip46') {
      authBlock = `
        <div class="settings-card">
          <div class="card-row">
            <div>
              <div class="card-label">Status</div>
              <div class="card-value ok">Connected via remote signer</div>
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

    // Dev-only relay toggle. Hidden unless Settings was opened with Alt held
    // (see the #open-settings handler). Dev/test builds keep it always-on so the e2e
    // specs that flip the relay mode don't have to synthesise a modifier click.
    const showDevCard = __DISCERNED_DEV_BUILD__ || devOptionsUnlocked;
    const relayDevCard = showDevCard ? `
          <div class="settings-card">
            <div class="card-label">Developer</div>
            <label class="toggle-row">
              <input type="checkbox" id="opt-local-relay" />
              <span class="toggle-label">
                <span class="toggle-title">Use local relay</span>
                <span class="toggle-desc">Publish to ws://localhost:7777 instead of the public relays. Syncs to the web app feed.</span>
              </span>
            </label>
          </div>
    ` : '';

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
            <button class="usage-row usage-row-link" id="open-library-btn"><span class="usage-label"><span class="status-icon">${DiscernedOverlay.ICON_CLIP}</span>Local clips</span><span class="usage-value" id="clip-count">—</span></button>
            <div class="usage-row"><span class="usage-label"><span class="status-icon">${DiscernedOverlay.ICON_CAST}</span>Public casts</span><span class="usage-value" id="cast-count">—</span></div>
          </div>
          <div class="settings-card">
            <div class="card-label">Appearance</div>
            <div class="format-row" id="theme-picker" role="group" aria-label="Theme">
              <button class="chip${this.themePref === 'system' ? ' active' : ''}" data-theme="system" type="button">🖥️ System</button>
              <button class="chip${this.themePref === 'dark' ? ' active' : ''}" data-theme="dark" type="button">🌙 Dark</button>
              <button class="chip${this.themePref === 'light' ? ' active' : ''}" data-theme="light" type="button">☀️ Light</button>
            </div>
          </div>
          <div class="settings-card">
            <div class="card-label">Relays</div>
            <div class="relay-readout" id="relay-readout">Loading…</div>
            <button class="link-btn" id="settings-manage-relays">Manage relays</button>
          </div>
          ${relayDevCard}
          <div class="settings-card">
            <button class="link-btn" id="settings-feedback">Send feedback or report a bug</button>
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
      // Re-probe NIP-07 immediately so a still-installed wallet is re-detected
      // without dismissing + reopening the overlay. A promotion to pro carries
      // NO pubkey, and this settings card renders pro-without-pubkey as "Signing
      // extension detected — sign in to connect" while the Disconnect button only
      // shows once a pubkey exists — so re-detecting here can't strand Disconnect.
      const probed = await detectAuthState().catch(() => null);
      if (probed?.type === 'pro') {
        await chrome.runtime.sendMessage({ type: 'NIP07_DETECTED', hasNIP07: true }).catch(() => { /* non-fatal */ });
      }
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

    // Content scripts have no chrome.tabs — the background opens the tab for us.
    this.shadow.getElementById('settings-feedback')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_FEEDBACK', target: 'extension' })
        .catch(() => { /* service worker asleep — non-fatal */ });
    });

    this.shadow.getElementById('settings-export')?.addEventListener('click', () => this.exportClips());

    // Relays are read-only here; editing lives in the web app's settings, which
    // is the single UI for the list (the extension remains the canonical store).
    this.shadow.getElementById('settings-manage-relays')?.addEventListener('click', () => {
      // Deep-link straight to the web app's settings panel — landing on the feed
      // and leaving the user to hunt for the gear isn't "manage relays".
      void chrome.runtime.sendMessage({ type: 'OPEN_HOME', openSettings: true });
      this.hide();
    });
    void this.loadRelayReadout();

    // Appearance theme picker — persist the choice; the storage.onChanged listener
    // (registered in show()) re-applies the theme and re-renders (moving the active chip).
    this.shadow.querySelectorAll('#theme-picker .chip').forEach((el) => {
      el.addEventListener('click', () => {
        const val = (el as HTMLElement).dataset.theme as Theme;
        void chrome.storage.local.set({ [STORAGE_KEYS.THEME]: val });
      });
    });

    void this.loadStats();
    void this.loadCaptureToggles();
    void this.loadOwnProfile();
  }

  // Fetch (once, cached) the kind-0 profile for the signed-in identity and patch
  // the name line into the settings identity block. Fire-and-forget; a relay miss
  // leaves the npub-only display in place.
  private async loadOwnProfile() {
    const a = this.authState;
    if (a.type === 'guest' || !a.pubkey) return;
    // Reuse an already-fetched profile for the same identity (shared with the tooltip).
    if (!this.ownProfile || this.ownProfile.pubkey !== a.pubkey) {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).catch(() => null);
      this.ownProfile = (res?.success && res.data) ? res.data as OwnProfile : null;
    }
    const p = this.ownProfile;
    const label = p?.verified && p.nip05 ? p.nip05 : (p?.name ?? '');
    const nameEl = this.shadow.getElementById('profile-name');
    if (nameEl && label) {
      nameEl.textContent = label;
      (nameEl as HTMLElement).style.display = '';
    }
    void this.updateNostrStatusTooltip();
  }

  // NOTE: the smartArticleDetection / stripInlineStyles checkboxes used to live
  // here. The UI was removed (unused); the flags themselves remain in the
  // capture pipeline at their `false` defaults — see CaptureOptions in capture.ts.
  private async loadCaptureToggles() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEYS.RELAYS]);

      // Dev relay toggle. Present in dev/test builds, and in any build when Settings
      // was opened with Alt held — so the existence check, not the build flag,
      // decides whether to wire it up. (Gating this on __DISCERNED_DEV_BUILD__
      // alone would render an inert checkbox in an Alt-opened production build.)
      {
        const relayEl = this.shadow.getElementById('opt-local-relay') as HTMLInputElement | null;
        if (relayEl) {
          relayEl.checked = resolveRelayMode(stored[STORAGE_KEYS.RELAYS] as string | undefined) === 'local';
          relayEl.addEventListener('change', () => {
            const mode = relayEl.checked ? 'local' : 'production';
            void chrome.storage.local.set({ [STORAGE_KEYS.RELAYS]: mode });
            // Broadcast so any open discerned tab re-subscribes its feed immediately.
            chrome.runtime.sendMessage({ type: 'RELAY_MODE_CHANGED', mode }).catch(() => { /* non-fatal */ });
          });
        }
      }
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

  // Fill the settings Relays card with the effective relay URLs (read-only).
  private async loadRelayReadout() {
    const el = this.shadow.getElementById('relay-readout');
    if (!el) return;
    try {
      const relays = await getEffectiveRelays();
      el.textContent = relays.join('\n');
    } catch {
      el.textContent = 'Could not read relay list';
    }
  }

  // Populate the "Connected to Nostr" footer tooltip with the user's npub slice
  // and the active relay count. Async because the relay mode lives in storage.
  private async updateNostrStatusTooltip() {
    try {
      const tip = this.shadow.getElementById('nostr-tip');
      if (!tip) return;
      const a = this.authState;
      const pubkey = a.type === 'guest' ? null : a.pubkey;
      let npubSlice = '';
      if (pubkey) {
        try { npubSlice = npubEncode(pubkey).slice(0, 12); } catch { npubSlice = ''; }
      }
      // Effective set, not just the mode defaults — otherwise the count goes
      // stale the moment the user adds or removes a relay.
      const relays = await getEffectiveRelays();
      const relayPart = `${relays.length} relay${relays.length === 1 ? '' : 's'}`;
      // Prefer the verified nip05 / display name over the bare npub when known.
      const p = this.ownProfile;
      const name = p && p.pubkey === pubkey ? (p.verified && p.nip05 ? p.nip05 : p.name) : undefined;
      const idPart = name ? name : (npubSlice ? `${npubSlice}…` : '');
      tip.textContent = idPart ? `${idPart} · ${relayPart}` : relayPart;
    } catch (err) {
      log(LL.WARN, 'Failed to set Nostr status tooltip', err);
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
    const isConnected = this.isConnected();
    const needsUnlock = this.needsUnlock();

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
          <h2>${DiscernedOverlay.BRAND_MARK} Discerned</h2>
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

          <div class="form-block">
            <label for="category">Category</label>
            <div class="combobox" id="category-combobox">
              <input type="text" id="category" value="${this.escapeHtml(this.category)}" autocomplete="off" spellcheck="false" />
              <button type="button" class="combobox-toggle" id="category-toggle" tabindex="-1">▾</button>
              <ul class="combobox-list" id="category-list" role="listbox">
              </ul>
            </div>
          </div>

          ${this.renderSignalBlock()}

          ${this.renderQualifiersBlock()}

          <div class="cast-notice" id="cast-notice">${this.renderCastNotice(isConnected)}</div>

        </div>

        <footer class="panel-footer">
          <div class="footer-meta">
            <div class="nostr-status${isConnected && !needsUnlock ? ' has-tip' : ''}" id="nostr-status">
              <span class="status-dot-text">
                <span class="status-dot${isConnected ? ' connected' : ''}"></span>
                <span class="status-text">${needsUnlock ? 'Connected · Locked' : isConnected ? 'Connected to Nostr' : 'Local only'}</span>
              </span>
              ${!isConnected ? '<button class="link-btn" id="nostr-signup-link">Connect →</button>' : ''}
              ${needsUnlock ? `<button class="link-btn" id="nostr-unlock-link"${this.publishMode === 'local' ? ' style="display:none"' : ''}>Unlock →</button>` : ''}
              ${isConnected && !needsUnlock ? '<span class="nostr-tip" id="nostr-tip" role="tooltip"></span>' : ''}
            </div>
            <div class="inline-unlock" id="inline-unlock" style="display:none">
              <input type="password" class="pin-input" id="inline-pin" placeholder="PIN" autocomplete="off" />
              <button class="btn btn-secondary" id="inline-unlock-btn" type="button">Unlock</button>
              <span class="inline-unlock-error" id="inline-unlock-error"></span>
            </div>
            <div class="publish-mode-slider${!isConnected ? ' guest' : ''}" role="radiogroup" aria-label="Publish mode">
              <div class="slider-track">
                <div class="slider-pill" id="slider-pill"></div>
                <button class="slider-seg${this.publishMode === 'cast' ? ' active' : ''}"
                        id="seg-cast" role="radio" aria-checked="${this.publishMode === 'cast'}"
                        ${!isConnected ? 'disabled' : ''}
                        title="Publish to Nostr — your clip is public and signed with your identity">${DiscernedOverlay.ICON_CAST}Cast</button>
                <button class="slider-seg${this.publishMode === 'both' ? ' active' : ''}"
                        id="seg-both" role="radio" aria-checked="${this.publishMode === 'both'}"
                        ${!isConnected ? 'disabled' : ''}
                        title="Save locally and publish to Nostr — your clip is public and signed with your identity">${DiscernedOverlay.ICON_CAST}${DiscernedOverlay.ICON_CLIP}Both</button>
                <button class="slider-seg${this.publishMode === 'local' ? ' active' : ''}"
                        id="seg-local" role="radio" aria-checked="${this.publishMode === 'local'}"
                        title="Keep local — stored only on this device, not published">${DiscernedOverlay.ICON_CLIP}Clip</button>
              </div>
            </div>
          </div>
          <button class="btn btn-clip" id="clip" disabled>
            <span class="label" id="clip-label">${this.getClipLabel()}</span>
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
    const isConnected = this.isConnected();

    this.shadow.getElementById('close')?.addEventListener('click', () => this.hide());
    this.shadow.getElementById('open-settings')?.addEventListener('click', (e) => {
      // Alt-click (Option on macOS) unlocks the Developer card. Latch it rather
      // than assigning altKey outright: once armed it stays armed for the rest of
      // the session, so an ordinary gear click later still shows the card.
      if ((e as MouseEvent).altKey) devOptionsUnlocked = true;
      this.view = 'settings';
      this.render();
    });

    if (isConnected) void this.updateNostrStatusTooltip();

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

    // ── Signal slider + qualifier chips ───────────────────────────────────────
    this.attachSignalSlider();
    this.attachQualifierChips();

    // ── Publish-mode slider ───────────────────────────────────────────────────
    const pill = this.shadow.getElementById('slider-pill');
    const clipLabelEl = this.shadow.getElementById('clip-label');
    const unlockLinkEl = this.shadow.getElementById('nostr-unlock-link');
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
      if (clipLabelEl) clipLabelEl.textContent = this.getClipLabel();
      // Clip-only mode never signs, so unlocking the stored key is pointless — hide the prompt.
      if (unlockLinkEl) unlockLinkEl.style.display = this.publishMode === 'local' ? 'none' : '';
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

    // Stored-key unlock: the footer "Unlock →" link reveals an inline PIN field.
    this.shadow.getElementById('nostr-unlock-link')?.addEventListener('click', () => {
      const box = this.shadow.getElementById('inline-unlock');
      if (box) box.style.display = 'flex';
      (this.shadow.getElementById('inline-pin') as HTMLInputElement | null)?.focus();
    });
    const inlinePin = this.shadow.getElementById('inline-pin') as HTMLInputElement | null;
    const submitInlineUnlock = () => { void this.unlockKeyInline(); };
    this.shadow.getElementById('inline-unlock-btn')?.addEventListener('click', submitInlineUnlock);
    inlinePin?.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === 'Enter') { e.preventDefault(); submitInlineUnlock(); }
      else if (key === 'Escape') {
        e.preventDefault();
        const box = this.shadow.getElementById('inline-unlock');
        if (box) box.style.display = 'none';
      }
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
    return `<span class="notice warn">Long body — cast publishes title, URL, note &amp; rating; full text stays local.</span>`;
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
    if (noticeEl) noticeEl.innerHTML = this.renderCastNotice(this.isConnected());
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

  // A NIP-07 signer can be detected (type='pro') without a pubkey — the user
  // has the wallet installed but hasn't completed Sign In on the web app, so
  // casts will fail. Treat that as not-connected; nip46/nsec always have a pubkey.
  private isConnected(): boolean {
    const a = this.authState;
    if (a.type === 'guest') return false;
    if (a.type === 'pro') return !!a.pubkey;
    return true;
  }

  // A stored key (nsec) is connected but unusable for casting until its PIN is
  // entered — the decrypted key lives only in the background SW's memory and is
  // cleared whenever Chrome recycles the SW. `unlocked` is reported by
  // GET_AUTH_STATE. When true here, the cast path prompts for the PIN inline.
  private needsUnlock(): boolean {
    return this.authState.type === 'nsec' && this.authState.unlocked !== true;
  }

  /**
   * SIGNAL RATING block: mono section head + amber readout, a native
   * horizontal range input, and clickable tick labels beneath. Unrated state
   * = `.unrated` on the wrapper (thumb/fill hidden, readout muted "Unrated",
   * Clear hidden); the native input still holds a parked midpoint value
   * because a range can't be valueless.
   */
  private renderSignalBlock(): string {
    const max = SIGNAL_LEVELS.length - 1;
    const rated = this.signal !== null;
    const idx = rated ? SIGNAL_LEVELS.indexOf(this.signal!) : 2;
    const pct = (idx / max) * 100;
    const ticks = SIGNAL_LEVELS.map((lvl, i) =>
      `<button type="button" class="signal-tick${this.signal === lvl ? ' selected' : ''}" data-idx="${i}" title="${this.escapeHtml(SIGNAL_DESCRIPTIONS[lvl])}">${lvl}</button>`
    ).join('');
    const fill = rated ? ` style="--sig-pct: ${pct}%"` : '';
    return `
      <div class="form-block signal-block">
        <div class="signal-head">
          <span class="section-head" id="signal-label">Signal Rating</span>
          <button type="button" class="signal-clear" id="signal-clear"${rated ? '' : ' hidden'}>Clear</button>
          <span class="signal-readout${rated ? '' : ' unset'}" id="signal-readout">${rated ? `${signalRank(this.signal!)} ★ ${this.signal}` : 'Unrated'}</span>
        </div>
        <div class="signal-slider${rated ? '' : ' unrated'}" id="signal-slider">
          <input type="range" id="signal-range" min="0" max="${max}" step="1"
                 value="${idx}" aria-labelledby="signal-label"
                 aria-valuetext="${this.signal ?? 'Unrated'}"${fill} />
        </div>
        <div class="signal-ticks" id="signal-ticks">${ticks}</div>
      </div>
    `;
  }

  private renderQualifiersBlock(): string {
    const chip = (q: string) =>
      `<button type="button" class="qchip${this.selectedQualifiers.has(q) ? ' active' : ''}" data-q="${this.escapeHtml(q)}">${this.escapeHtml(q)}</button>`;
    const groups = QUALIFIER_GROUPS.map(g => `
      <div class="qual-group">
        <div class="qual-group-label">${this.escapeHtml(g.label)}</div>
        <div class="qual-chips">${g.items.map(chip).join('')}</div>
      </div>
    `).join('');
    return `
      <div class="form-block qualifiers-block">
        <div class="section-head">Qualifiers</div>
        ${groups}
        <div class="qual-group">
          <div class="qual-group-label">Custom</div>
          <div class="qual-chips" id="custom-qual-chips">
            ${this.customQualifiers.map(chip).join('')}
            <input type="text" id="qual-input" class="qual-input" placeholder="+ add custom tag" maxlength="40" autocomplete="off" spellcheck="false" />
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Wire the signal slider. State model: `this.signal === null` ⇔ wrapper has
   * `.unrated` ⇔ thumb/fill hidden ⇔ readout "Unrated" ⇔ Clear hidden. Once a
   * value is committed the native range owns click/drag/keyboard via `input`.
   */
  private attachSignalSlider(): void {
    const wrap    = this.shadow.getElementById('signal-slider');
    const range   = this.shadow.getElementById('signal-range') as HTMLInputElement | null;
    const readout = this.shadow.getElementById('signal-readout');
    const clear   = this.shadow.getElementById('signal-clear') as HTMLButtonElement | null;
    const ticks   = this.shadow.getElementById('signal-ticks');
    if (!wrap || !range || !readout || !clear || !ticks) return;

    const max = SIGNAL_LEVELS.length - 1;

    const paint = () => {
      const rated = this.signal !== null;
      const idx = rated ? SIGNAL_LEVELS.indexOf(this.signal!) : -1;
      wrap.classList.toggle('unrated', !rated);
      readout.classList.toggle('unset', !rated);
      readout.textContent = rated ? `${signalRank(this.signal!)} ★ ${this.signal}` : 'Unrated';
      clear.hidden = !rated;
      range.setAttribute('aria-valuetext', this.signal ?? 'Unrated');
      if (rated) range.style.setProperty('--sig-pct', `${(idx / max) * 100}%`);
      else range.style.removeProperty('--sig-pct');
      ticks.querySelectorAll<HTMLElement>('.signal-tick').forEach(el => {
        el.classList.toggle('selected', Number(el.dataset.idx) === idx);
      });
    };

    const commit = (idx: number) => {
      const clamped = Math.max(0, Math.min(max, Math.round(idx)));
      this.signal = SIGNAL_LEVELS[clamped]!;
      range.value = String(clamped);
      paint();
    };

    const clearSignal = () => {
      this.signal = null;
      range.value = '2'; // park at midpoint; invisible while .unrated
      paint();
    };

    // Native `input` covers click/drag/keyboard once rated.
    range.addEventListener('input', () => commit(Number(range.value)));

    // While unrated, a click landing exactly on the parked midpoint fires no
    // `input` (value unchanged) — commit from the pointer position instead.
    wrap.addEventListener('pointerdown', e => {
      if (this.signal !== null) return;
      const r = range.getBoundingClientRect();
      commit(((e.clientX - r.left) / r.width) * max);
    });

    range.addEventListener('keydown', e => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        clearSignal();
        return;
      }
      if (this.signal !== null) return; // rated → native keys fire `input`
      // While unrated the first press SELECTS rather than moves.
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        commit(2); // Ordinary (midpoint)
      } else if (e.key === 'Home') {
        e.preventDefault();
        commit(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        commit(max);
      }
    });

    clear.addEventListener('click', clearSignal);

    ticks.addEventListener('click', e => {
      const t = (e.target as Element).closest<HTMLElement>('.signal-tick');
      if (!t?.dataset.idx) return;
      commit(Number(t.dataset.idx));
    });
  }

  private attachQualifierChips(): void {
    const block = this.shadow.querySelector<HTMLElement>('.qualifiers-block');
    const input = this.shadow.getElementById('qual-input') as HTMLInputElement | null;
    const customRow = this.shadow.getElementById('custom-qual-chips');
    if (!block || !input || !customRow) return;

    block.addEventListener('click', e => {
      const chipEl = (e.target as Element).closest<HTMLElement>('.qchip');
      if (!chipEl?.dataset.q) return;
      const q = chipEl.dataset.q;
      if (this.selectedQualifiers.has(q)) this.selectedQualifiers.delete(q);
      else this.selectedQualifiers.add(q);
      chipEl.classList.toggle('active', this.selectedQualifiers.has(q));
    });

    // Typed custom qualifiers persist (like custom categories) and select immediately.
    const addCustom = () => {
      const trimmed = input.value.trim();
      if (!trimmed) return;
      input.value = '';
      const known = [...QUALIFIER_GROUPS.flatMap(g => [...g.items]), ...this.customQualifiers];
      const existing = known.find(q => q.toLowerCase() === trimmed.toLowerCase());
      if (existing) {
        this.selectedQualifiers.add(existing);
        block.querySelectorAll<HTMLElement>('.qchip').forEach(el => {
          if (el.dataset.q === existing) el.classList.add('active');
        });
        return;
      }
      this.customQualifiers.push(trimmed);
      void chrome.storage.local.set({ [STORAGE_KEYS.QUALIFIERS]: [...this.customQualifiers] });
      this.selectedQualifiers.add(trimmed);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qchip active';
      btn.dataset.q = trimmed;
      btn.textContent = trimmed;
      customRow.insertBefore(btn, input);
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustom();
      }
    });
    input.addEventListener('blur', addCustom);
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
    // Signal + qualifiers are optional (unrated is a valid state); only a
    // category and a finished capture are required.
    const category = (this.shadow.getElementById('category') as HTMLInputElement | null)?.value.trim();
    const isValid = !!category && !!this.capture && !this.capturing;
    const clipBtn = this.shadow.getElementById('clip') as HTMLButtonElement | null;
    if (clipBtn) clipBtn.disabled = !isValid;
  }

  private getEvaluation(): Evaluation {
    const category = ((this.shadow.getElementById('category') as HTMLInputElement).value.trim() || 'General') as Category;
    return { signal: this.signal ?? undefined, qualifiers: [...this.selectedQualifiers], category };
  }

  private async handleClipAction() {
    if (!this.opts || !this.capture) return;
    const isConnected = this.isConnected();
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
      this.showSuccess('Clipped!', { clipId: captureWithNote.id, icon: DiscernedOverlay.ICON_CLIP });

    } else if (mode === 'cast') {
      // CAST only publishes to Nostr; local save requires an explicit CLIP action.
      this.removePreview();
      // No glyph: showLoading writes via textContent (no markup), and the spinner
      // beside it already carries "in progress".
      await this.publishWithUnlock(() => this.opts!.onCast(captureWithNote, evaluation), 'Casting…');

    } else {
      // both: explicit local save first (idempotent double-save is safe), then publish.
      try { await this.opts.onClip(captureWithNote, evaluation); }
      catch { this.showError('Failed to clip. Please try again.'); return; }
      this.removePreview();
      await this.publishWithUnlock(
        () => this.opts!.onCast(captureWithNote, evaluation),
        'Clipped! Casting…',
        captureWithNote.id,
      );
    }

    void chrome.storage.local.set({
      [STORAGE_KEYS.LAST_PUBLISH_MODE]: this.publishMode,
      [STORAGE_KEYS.LAST_CATEGORY]:     evaluation.category,
    });
  }

  /**
   * Run a publish, unlocking a stored key first if needed. A stored key (nsec)
   * can be locked because the decrypted key lives only in the background SW's
   * memory and Chrome recycles the SW aggressively. Two paths land here:
   *  - pre-check: `needsUnlock()` is already true → prompt before publishing.
   *  - mid-cast race: the SW dies between the pre-check and the sign call, so the
   *    cast rejects with `PIN_REQUIRED` → prompt, then auto-retry once unlocked.
   * `clipId` (set in `both` mode) keeps the "View in Clips" link on the result.
   */
  private async publishWithUnlock(
    cast: () => Promise<string | undefined>,
    loadingText: string,
    clipId?: string,
  ): Promise<void> {
    // Both-mode shows both glyphs in the same cast-then-clip order as the Both button.
    const succeed = (eventId?: string) =>
      this.showSuccess(clipId ? 'Clipped & cast' : 'Cast published', {
        clipId,
        eventId,
        icon: clipId
          ? `${DiscernedOverlay.ICON_CAST}${DiscernedOverlay.ICON_CLIP}`
          : DiscernedOverlay.ICON_CAST,
      });

    if (this.needsUnlock()) {
      const unlocked = await this.promptUnlockInLoading();
      if (!unlocked) {
        // User cancelled — keep the local clip (both mode) but report no publish.
        if (clipId) this.showSuccess('Clipped · not cast', { clipId, icon: DiscernedOverlay.ICON_CLIP });
        else this.showError('Cast cancelled — your key is still locked.');
        return;
      }
    }

    this.showLoading(loadingText);
    try {
      succeed(await cast());
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'PIN_REQUIRED') {
        // SW was recycled between the pre-check and signing — prompt then retry once.
        const unlocked = await this.promptUnlockInLoading();
        if (!unlocked) {
          if (clipId) this.showSuccess('Clipped · not cast', { clipId, icon: DiscernedOverlay.ICON_CLIP });
          else this.showError('Cast cancelled — your key is still locked.');
          return;
        }
        this.showLoading(loadingText);
        try {
          succeed(await cast());
          return;
        } catch (retryErr: unknown) {
          log(LL.WARN, 'Discerned: cast failed after unlock',
            retryErr instanceof Error ? retryErr.message : retryErr);
        }
      } else {
        log(LL.WARN, 'Discerned: cast failed', err instanceof Error ? err.message : err);
      }
      // Local clip already saved (both mode) — surface the failure but keep the link.
      // Name the likely cause: this is usually the signer declining, which the user can fix.
      if (clipId) this.showSuccess('Clipped · cast failed', { clipId, icon: DiscernedOverlay.ICON_CLIP });
      else this.showError('Cast failed — your signer may have declined or timed out.');
    }
  }

  /**
   * Render an inline PIN form inside the #loading panel and resolve true once the
   * stored key is unlocked, or false if the user cancels. Loops on wrong PIN.
   * On success the cached `authState.unlocked` is flipped so the footer updates.
   */
  private promptUnlockInLoading(): Promise<boolean> {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return Promise.resolve(false);
    const ev = this.escapeHtml.bind(this);
    loading.style.display = 'flex';
    loading.innerHTML = `
      <div class="unlock-prompt">
        <p class="unlock-title">🔒 Enter your PIN to unlock your key</p>
        <input type="password" class="pin-input" id="cast-pin" placeholder="PIN" autocomplete="off" />
        <span class="inline-unlock-error" id="cast-pin-error"></span>
        <div class="unlock-actions">
          <button class="btn btn-clip" id="cast-unlock-btn" type="button">Unlock &amp; Cast</button>
          <button class="dismiss-btn" id="cast-unlock-cancel" type="button">Cancel</button>
        </div>
      </div>`;
    const pinEl = loading.querySelector('#cast-pin') as HTMLInputElement | null;
    const errEl = loading.querySelector('#cast-pin-error');
    pinEl?.focus();

    return new Promise<boolean>((resolve) => {
      const submit = async () => {
        const pin = pinEl?.value ?? '';
        if (!pin) return;
        if (errEl) errEl.textContent = '';
        const res = await chrome.runtime.sendMessage({ type: 'UNLOCK_NSEC', pin }).catch(() => null);
        if (res?.success) {
          if (this.authState.type === 'nsec') this.authState = { ...this.authState, unlocked: true };
          resolve(true);
        } else {
          if (errEl) errEl.textContent = ev(res?.error ?? 'Incorrect PIN. Please try again.');
          if (pinEl) { pinEl.value = ''; pinEl.focus(); }
        }
      };
      loading.querySelector('#cast-unlock-btn')?.addEventListener('click', () => void submit());
      pinEl?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void submit(); }
      });
      loading.querySelector('#cast-unlock-cancel')?.addEventListener('click', () => resolve(false));
    });
  }

  /**
   * Unlock the stored key from the footer "Unlock →" link's inline PIN field,
   * then re-render so the footer reflects the unlocked state.
   */
  private async unlockKeyInline(): Promise<void> {
    const pinEl = this.shadow.getElementById('inline-pin') as HTMLInputElement | null;
    const errEl = this.shadow.getElementById('inline-unlock-error');
    const pin = pinEl?.value ?? '';
    if (!pin) return;
    if (errEl) errEl.textContent = '';
    const res = await chrome.runtime.sendMessage({ type: 'UNLOCK_NSEC', pin }).catch(() => null);
    if (res?.success) {
      if (this.authState.type === 'nsec') this.authState = { ...this.authState, unlocked: true };
      this.render();
    } else {
      if (errEl) errEl.textContent = this.escapeHtml(res?.error ?? 'Incorrect PIN. Please try again.');
      if (pinEl) { pinEl.value = ''; pinEl.focus(); }
    }
  }

  private showLoading(text: string) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    loading.style.display = 'flex';
    const p = loading.querySelector('p');
    if (p) p.textContent = text;
  }

  /**
   * `icon` takes RAW markup and is the one field here that bypasses escaping — pass
   * ONLY the static ICON_* constants below, never anything derived from a capture,
   * a relay response, or a signer error. `message` stays escaped.
   */
  private showSuccess(
    message: string,
    opts: { clipId?: string; eventId?: string; icon?: string } = {},
  ) {
    const loading = this.shadow.getElementById('loading');
    if (!loading) return;
    const { clipId, eventId, icon } = opts;
    const libraryBtn = clipId
      ? `<button class="open-library-btn">View in My Clips →</button>` : '';
    const discernBtn = eventId
      ? `<button class="open-discern-btn">View in Discerns →</button>` : '';
    const links = [libraryBtn, discernBtn].filter(Boolean).join('<br>');
    const glyph = icon ? `<span class="status-icon">${icon}</span>` : '✓';
    loading.innerHTML = `<div class="success">${glyph} ${this.escapeHtml(message)}${links ? `<br>${links}` : ''}<br><button class="dismiss-btn">Dismiss</button></div>`;
    if (clipId) {
      loading.querySelector('.open-library-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY', clipId }).catch(() => {});
        this.hide();
      });
    }
    if (eventId) {
      loading.querySelector('.open-discern-btn')?.addEventListener('click', () => {
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

  private getClipLabel(): string {
    if (this.publishMode === 'cast') return 'CAST';
    if (this.publishMode === 'both') return 'CLIP & CAST';
    return 'CLIP';
  }

  // Monochrome line icons for the publish-mode slider, the result messages, and the
  // settings usage rows. Stroke uses currentColor so they follow the surrounding text
  // colour — muted/white on the slider, success amber or error red in a status line.
  // Public because content.ts's cast-error toast renders in its own shadow root.
  static readonly ICON_CAST =
    `<svg class="seg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M4.9 19.1A10 10 0 0 1 4.9 5M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2"/><circle cx="12" cy="12" r="1.5"/></svg>`;
  static readonly ICON_CLIP =
    `<svg class="seg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M21 11.5l-8.8 8.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>`;

  // The Discerned beacon, replacing the 📡 emoji in the panel header. Geometry is the
  // same drawing as discerned-web's MiniBeacon.tsx and the toolbar icon masters in
  // art/ — keep them in sync if the silhouette ever changes.
  //
  // currentColor, NOT the azure of the toolbar icon: the overlay's accent is amber
  // (see shared/theme.ts), so a blue mark would clash. Inheriting the h2's ink is what
  // MiniBeacon does on the web too.
  //
  // viewBox is the mark's TIGHT bbox (4 3 24 30) rather than MiniBeacon's raw
  // 0 0 32 36, which carries ~4 units of empty margin per side — with the raw box the
  // mark renders ~17% smaller than the CSS height suggests and looks undersized next
  // to the wordmark.
  static readonly BRAND_MARK =
    `<svg class="brand-mark" viewBox="4 3 24 30" fill="none" aria-hidden="true">` +
    `<g stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5">` +
    `<line x1="16" y1="9" x2="16" y2="3"/><line x1="11.5" y1="10" x2="7.5" y2="6"/>` +
    `<line x1="20.5" y1="10" x2="24.5" y2="6"/><line x1="9" y1="13" x2="4" y2="12"/>` +
    `<line x1="23" y1="13" x2="28" y2="12"/></g>` +
    `<circle cx="16" cy="14" r="5" fill="currentColor" opacity="0.12"/>` +
    `<path d="M 15.5 7 L 16.5 7 L 16 4 Z" fill="currentColor"/>` +
    `<circle cx="16" cy="14" r="2.4" fill="currentColor"/>` +
    `<rect x="13.2" y="15.5" width="5.6" height="2.4" rx="0.5" fill="currentColor"/>` +
    `<path d="M 14.2 18 L 17.8 18 L 19.4 33 L 12.6 33 Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>` +
    `<line x1="13.4" y1="22.5" x2="18.6" y2="22.5" stroke="currentColor" stroke-width="0.9" opacity="0.7"/>` +
    `<line x1="13" y1="27" x2="19" y2="27" stroke="currentColor" stroke-width="0.9" opacity="0.7"/>` +
    `<line x1="11" y1="33" x2="21" y2="33" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

  // ── Styles ─────────────────────────────────────────────────────────────────

  private getStyles(): string {
    return `
      :host {
        display: block;
        /* Page CSS can target our host <div> with cascade-winning selectors;
           force visibility so we're never accidentally hidden. */
        visibility: visible !important;

        /* pointer-events is INHERITED and inheritance crosses the shadow
           boundary. Paywalls/interstitials that freeze the page set
           pointer-events:none on body, which left the panel inert and made a
           real click on it read as an outside click (bloomberg.com, msn.com). */
        pointer-events: auto !important;

        /* Design tokens for the active theme (see shared/theme.ts). Includes
           color-scheme so shadow-root scrollbars/form controls follow the theme. */
${themeVarsBlock(this.effectiveTheme)}
      }
      * { margin: 0; padding: 0; box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

      /* color-scheme alone doesn't reach shadow-root scrollers in Chromium —
         style them explicitly so they don't render as light-theme bars. */
      .discerned-root *::-webkit-scrollbar { width: 10px; height: 10px; }
      .discerned-root *::-webkit-scrollbar-track { background: transparent; }
      .discerned-root *::-webkit-scrollbar-thumb { background: var(--p-rule); }
      .discerned-root *::-webkit-scrollbar-thumb:hover { background: var(--p-ink-4); }
      .discerned-root *::-webkit-scrollbar-button { display: none; height: 0; width: 0; }

      .discerned-root.panel {
        visibility: visible;
        /* Re-assert against an inherited pointer-events:none (see :host). */
        pointer-events: auto;
        position: fixed; top: 0; left: 0; bottom: 0;
        width: 380px; max-width: 90vw;
        background: var(--p-bg);
        color: var(--p-ink);
        backdrop-filter: blur(18px) saturate(150%);
        -webkit-backdrop-filter: blur(18px) saturate(150%);
        border-right: 1px solid var(--p-panel-border);
        box-shadow: var(--p-panel-shadow);
        z-index: 2147483647;
        display: flex; flex-direction: column;
        animation: slideIn 0.18s ease-out;
      }
      /* Opaque fallback for browsers without backdrop-filter (some Firefox forks, older Chromium on Linux). */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .discerned-root.panel { background: var(--p-panel-opaque); }
      }
      @keyframes slideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
      /* Re-renders after the initial mount carry .no-anim so the panel doesn't
         replay the slide-in each time show() patches the view. */
      .discerned-root.panel.no-anim { animation: none; }

      .panel-header {
        flex: 0 0 auto;
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--p-rule);
      }
      .panel-header h2 { color: var(--p-ink); font-size: 15px; font-weight: 700; flex: 1;
                         font-family: var(--p-mono); text-transform: uppercase; letter-spacing: 0.06em;
                         display: flex; align-items: center; gap: 7px; }
      /* Beacon brand mark; inherits the h2's ink via currentColor. The 24x30 tight
         bbox viewBox means these px values are the mark's real rendered size. */
      .panel-header h2 .brand-mark { width: 13px; height: 16px; flex: none; display: block; }
      .header-actions { display: flex; gap: 4px; }

      .icon-btn {
        background: none; border: none; color: var(--p-ink-3);
        cursor: pointer; width: 30px; height: 30px;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px; transition: all 0.15s;
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
        padding: 6px 10px;
        cursor: pointer; transition: all 0.15s;
        display: inline-flex; align-items: center; gap: 6px;
        font-family: inherit;
      }
      /* :not(.active) so hover never overrides the active chip's text colour — without
         it, hover (higher specificity than .chip.active) keeps the active text dark
         until the cursor leaves, so the active colour appeared to apply only on mouse-out. */
      .chip:hover:not(:disabled):not(.active) { border-color: var(--p-ink-4); color: var(--p-ink); }
      .chip.active { background: var(--p-cta-bg); border-color: var(--p-cta-bg); color: var(--p-cta-ink); font-weight: 500; }
      .chip:disabled { opacity: 0.4; cursor: not-allowed; }
      .chip-icon { font-size: 13px; }

      /* Preview area */
      .preview-area { display: block; }
      .preview-card {
        background: var(--p-surface);
        border-left: 4px solid var(--p-accent);
        padding: 12px;
        display: flex; flex-direction: column; gap: 6px;
      }
      .preview-thumb {
        max-width: 100%; max-height: 120px; width: auto; height: auto;
        object-fit: contain; align-self: flex-start;
      }
      .preview-title { color: var(--p-ink); font-size: 14px; font-weight: 600; }
      .preview-text  { color: var(--p-ink-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
      .preview-url   { color: var(--p-ink-3); font-size: 11px; word-break: break-all; }
      .preview-hint  { color: var(--p-accent-ink); font-size: 11px; }
      .preview-placeholder {
        background: var(--p-surface); border: 1px dashed var(--p-rule);
        padding: 14px;
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
        font-family: var(--p-mono);
      }
      .form-group { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      label {
        color: var(--p-ink-2); font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap;
        font-family: var(--p-mono);
      }

      textarea#note-input {
        width: 100%; min-height: 56px;
        background: var(--p-surface); border: 1px solid var(--p-rule);
        color: var(--p-ink);
        font-family: inherit; font-size: 13px;
        padding: 8px 10px; resize: vertical;
        outline: none; transition: border-color 0.15s, box-shadow 0.15s;
      }
      textarea#note-input::placeholder { color: var(--p-ink-4); }
      textarea#note-input:focus { border-color: var(--p-accent); box-shadow: 0 0 0 3px var(--p-focus-ring); }

      select {
        background: var(--p-surface); border: 1px solid var(--p-rule); color: var(--p-ink);
        padding: 8px; font-size: 12px;
        width: 100%; font-family: inherit; cursor: pointer;
        transition: border-color 0.2s;
      }
      select:hover { border-color: var(--p-ink-3); }
      select:focus { outline: none; border-color: var(--p-accent); box-shadow: 0 0 0 3px var(--p-focus-ring); }

      /* Combobox */
      .combobox { position: relative; display: flex; }
      .combobox input[type="text"] {
        flex: 1; min-width: 0; background: var(--p-surface);
        border: 1px solid var(--p-rule); border-right: none; color: var(--p-ink);
        padding: 8px;
        font-size: 12px; font-family: inherit; transition: border-color 0.2s;
      }
      .combobox-toggle {
        background: var(--p-surface); border: 1px solid var(--p-rule); border-left: none;
        color: var(--p-ink-3); padding: 0 8px;
        cursor: pointer; font-size: 11px; transition: border-color 0.2s;
      }
      .combobox:focus-within input[type="text"],
      .combobox:focus-within .combobox-toggle { border-color: var(--p-accent); }
      .combobox input[type="text"]:focus { outline: none; box-shadow: 0 0 0 3px var(--p-focus-ring); }
      .combobox-toggle:hover { color: var(--p-ink); }

      .combobox-list {
        display: none; position: absolute; top: calc(100% + 3px); left: 0; right: 0;
        background: var(--p-surface-solid);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        border: 1px solid var(--p-rule);
        list-style: none; z-index: 9999;
        max-height: 180px; overflow-y: auto;
        box-shadow: 0 6px 18px rgba(0,0,0,0.5);
      }
      .combobox-list.open { display: block; }
      .combobox-list li { padding: 4px 10px; line-height: 1.3; color: var(--p-ink); font-size: 12px; cursor: pointer; font-family: inherit; }
      .combobox-list li:hover { background: var(--p-accent); color: var(--p-on-accent); }
      .combobox-list li.custom-entry { color: var(--p-ink-3); font-style: italic; }

      /* Cast notice */
      .cast-notice { min-height: 0; }
      .notice { font-size: 11px; line-height: 1.4; }
      .notice.ok   { color: var(--p-accent-ink); }
      .notice.warn { color: var(--p-warn-ink); }

      /* Footer meta */
      /* Top-align so the status row stays put when the Unlock link wraps below it
         (it grows downward instead of recentering the whole column). */
      .footer-meta { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      /* flex-wrap stays enabled so #nostr-unlock-link (flex-basis: 100%, below)
         can drop to its own line — but the dot+text pair itself must never
         split across lines, so it's wrapped in its own inline-flex (nowrap)
         group. Without this, dark mode's --p-mono (a real monospace font,
         wider per-char than light's sans stack) pushed "Connected to Nostr"
         past the row's width and wrapped the text below the dot. */
      .nostr-status { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin-top: -3px; }
      .nostr-status.has-tip { position: relative; cursor: default; }
      .status-dot-text { display: inline-flex; align-items: center; flex-wrap: nowrap; gap: 6px; min-width: 0; }
      .status-dot { width: 12px; height: 12px; background: var(--p-ink-4); border-radius: 50%; flex-shrink: 0; }
      .status-dot.connected { background: var(--p-connected); }
      .status-text { font-size: 11px; color: var(--p-ink-3); white-space: nowrap; font-family: var(--p-mono); }
      /* Keep dot + status text on one line; push the Unlock link to its own line beneath,
         right-aligned (so its right edge sits under the end of "Locked") and pulled up a bit. */
      #nostr-unlock-link { flex-basis: 100%; text-align: right; margin-top: -2px; padding-right: 1em; }
      /* Hover tooltip for the connected status (npub slice + relay count). */
      .nostr-tip {
        position: absolute; bottom: calc(100% + 7px); left: 0;
        white-space: nowrap; pointer-events: none;
        background: var(--p-surface-2); color: var(--p-ink);
        border: 1px solid var(--p-rule);
        font-size: 11px; font-family: var(--p-mono, monospace);
        padding: 5px 8px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        opacity: 0; transform: translateY(3px);
        transition: opacity 0.14s, transform 0.14s; z-index: 10000;
      }
      .nostr-status.has-tip:hover .nostr-tip { opacity: 1; transform: translateY(0); }
      .nostr-tip::after {
        content: ''; position: absolute; top: 100%; left: 10px;
        border: 4px solid transparent; border-top-color: var(--p-surface-2);
      }
      /* Nudge up so its centre lines up with the (now top-aligned) status row,
         and pull right toward the panel edge a touch. */
      .publish-mode-slider { display: flex; align-items: center; margin-top: -11px; margin-right: -6px; }
      .slider-track {
        position: relative; display: grid; grid-template-columns: repeat(3, 1fr);
        background: var(--p-surface); border: 1px solid var(--p-rule);
        overflow: hidden; height: 37px; width: 232px;
      }
      .slider-pill {
        position: absolute; top: 2px; bottom: 2px; left: 2px;
        width: calc(33.333% - 2px); background: var(--p-cta-bg);
        pointer-events: none;
        /* Snappy ease-out (no spring overshoot). The previous
           cubic-bezier(0.34,1.56,0.64,1) bounced past the target and settled
           back, which read as a laggy dark→light transition on the segment. */
        transition: transform 0.14s cubic-bezier(0.4, 0, 0.2, 1);
        will-change: transform;
      }
      .slider-seg {
        position: relative; z-index: 1; background: none; border: none;
        color: var(--p-ink-3); font-size: 13px; font-weight: 500; cursor: pointer;
        padding: 0 4px; display: flex; align-items: center; justify-content: center;
        gap: 4px; white-space: nowrap; transition: color 0.15s; font-family: var(--p-mono);
      }
      .slider-seg .seg-icon { width: 15px; height: 15px; flex-shrink: 0; }
      /* On "Both" two icons sit side by side — pull them tighter than the icon→label gap. */
      #seg-both .seg-icon + .seg-icon { margin-left: -2px; }
      /* :not(.active) — see .chip note; keep the active segment's text colour on hover. */
      .slider-seg:hover:not(:disabled):not(.active) { color: var(--p-ink); }
      .slider-seg.active { color: var(--p-on-accent); font-weight: 600; }
      .slider-seg:disabled { opacity: 0.4; cursor: not-allowed; }
      .publish-mode-slider.guest .slider-seg:not(#seg-local) { opacity: 0.4; cursor: not-allowed; }
      .slider-seg:focus-visible { outline: 2px solid var(--p-accent); outline-offset: -2px; }

      /* ── Signal rating (single horizontal slider) ─────────────────────── */
      .signal-block { gap: 8px; }
      .section-head {
        font-family: var(--p-mono); font-size: 11px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--p-ink-3);
      }
      .signal-head { display: flex; align-items: baseline; gap: 10px; }
      .signal-head .section-head { flex: 1; }
      .signal-clear {
        background: none; border: none; padding: 0;
        font-family: var(--p-mono); font-size: 10px;
        text-transform: uppercase; letter-spacing: 0.05em;
        color: var(--p-ink-4); text-decoration: underline; cursor: pointer;
      }
      .signal-clear:hover { color: var(--p-ink); }
      .signal-readout {
        font-family: var(--p-mono); font-size: 13px; font-weight: 700;
        color: var(--p-accent); white-space: nowrap;
      }
      .signal-readout.unset { color: var(--p-ink-4); font-weight: 400; }
      .signal-slider input[type="range"] {
        -webkit-appearance: none; appearance: none;
        display: block; width: 100%; height: 20px;
        background: transparent; cursor: pointer; outline: none;
      }
      .signal-slider input[type="range"]::-webkit-slider-runnable-track {
        height: 4px;
        background: linear-gradient(to right,
          var(--p-accent) var(--sig-pct, 0%),
          var(--p-rule) var(--sig-pct, 0%));
      }
      .signal-slider.unrated input[type="range"]::-webkit-slider-runnable-track {
        background: var(--p-rule);
      }
      .signal-slider input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 8px; height: 18px; margin-top: -7px;
        background: var(--p-accent);
        border: none;
      }
      .signal-slider.unrated input[type="range"]::-webkit-slider-thumb { opacity: 0; }
      .signal-slider input[type="range"]:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
      .signal-ticks { display: flex; justify-content: space-between; }
      /* --p-ink-3, not --p-ink-4: these are the only labels for the scale, so
         they must be readable unhovered. --p-ink-4 is for de-emphasised chrome. */
      .signal-tick {
        background: none; border: none; padding: 0;
        font-family: var(--p-mono); font-size: 10px;
        text-transform: uppercase; letter-spacing: 0.03em;
        color: var(--p-ink-3); cursor: pointer; transition: color .12s;
      }
      .signal-tick:hover { color: var(--p-ink-2); }
      .signal-tick.selected { color: var(--p-ink); font-weight: 700; }

      /* ── Qualifier chips ──────────────────────────────────────────────── */
      .qualifiers-block { gap: 8px; }
      .qual-group { display: flex; flex-direction: column; gap: 5px; }
      .qual-group-label {
        font-family: var(--p-mono); font-size: 10px;
        text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--p-ink-4);
      }
      .qual-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .qchip {
        background: var(--p-surface); border: 1px solid var(--p-rule);
        color: var(--p-ink-3); font-size: 12px; font-family: inherit;
        padding: 4px 10px; cursor: pointer;
        transition: border-color .12s, color .12s, background .12s;
      }
      .qchip:hover:not(.active) { border-color: var(--p-ink-4); color: var(--p-ink); }
      .qchip.active {
        background: var(--p-cta-bg); border-color: var(--p-cta-bg);
        color: var(--p-cta-ink); font-weight: 500;
      }
      .qual-input {
        background: transparent; border: 1px dashed var(--p-rule);
        color: var(--p-ink); font-family: var(--p-mono); font-size: 11px;
        padding: 4px 8px; width: 76px; outline: none;
      }
      .qual-input::placeholder { color: var(--p-ink-4); }
      .qual-input:focus { border-style: solid; border-color: var(--p-accent); }

      .link-btn {
        background: none; border: none; color: var(--p-accent-ink);
        font-size: 11px; cursor: pointer; padding: 0 0 0 6px;
        text-decoration: underline; font-family: inherit; line-height: 1;
      }
      .link-btn:hover { color: var(--p-accent); }

      /* Buttons */
      .btn {
        padding: 14px; border: none;
        font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        font-family: inherit;
      }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 12px var(--p-cta-shadow); }
      .btn-secondary { background: var(--p-surface); color: var(--p-ink); border: 1px solid var(--p-rule); }
      .btn-secondary:not(:disabled):hover { background: var(--p-surface-2); }
      .btn-primary { background: var(--p-cta-bg); color: var(--p-cta-ink); }
      .btn-primary:not(:disabled):hover { background: var(--p-cta-bg-hover); }
      .btn-clip {
        width: 33.333%; margin: 0 auto;
        flex-direction: row; justify-content: center; padding: 9px 14px;
        background: var(--p-cta-bg); color: var(--p-cta-ink);
        box-shadow: 0 2px 8px var(--p-cta-shadow);
      }
      .btn-clip:not(:disabled):hover { background: var(--p-cta-bg-hover); }
      .btn-ghost { background: var(--p-surface); color: var(--p-ink-3); border: 1px solid var(--p-rule); }
      .btn-ghost:hover { background: var(--p-surface-2); color: var(--p-ink); }
      .btn .label { font-size: 13px; font-family: var(--p-mono); }

      /* Gate */
      .gate-body {
        display: flex; flex-direction: column; align-items: center;
        text-align: center; padding: 28px 20px; gap: 14px;
      }
      .gate-icon { font-size: 40px; }
      .gate-title { font-size: 15px; font-weight: 700; color: var(--p-ink); font-family: var(--p-mono); }
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
        font-family: var(--p-mono);
      }
      .tab-btn:hover { color: var(--p-ink); }
      .tab-btn.active { color: var(--p-accent); border-bottom-color: var(--p-accent); }
      .identity-panel { display: flex; flex-direction: column; gap: 10px; }
      .panel-desc { font-size: 12px; color: var(--p-ink-2); line-height: 1.6; }
      .panel-desc a { color: var(--p-accent-ink); text-decoration: none; }
      .panel-desc a:hover { text-decoration: underline; }
      .panel-desc code { background: var(--p-surface); border: 1px solid var(--p-rule); padding: 1px 5px; font-size: 0.9em; color: var(--p-accent-ink); }
      .panel-warning { background: var(--p-warn-bg); border: 1px solid var(--p-warn-border); padding: 10px 12px; font-size: 12px; color: var(--p-warn-ink); line-height: 1.5; }
      textarea {
        width: 100%; background: var(--p-surface); border: 1px solid var(--p-rule);
        color: var(--p-ink);
        font-family: var(--p-mono); font-size: 12px;
        padding: 10px; resize: vertical; min-height: 56px;
        outline: none; transition: border-color 0.15s;
      }
      textarea:focus { border-color: var(--p-accent); }
      input[type="password"] {
        width: 100%; background: var(--p-surface); border: 1px solid var(--p-rule);
        color: var(--p-ink);
        font-size: 13px; padding: 10px;
        outline: none; transition: border-color 0.15s; font-family: inherit;
      }
      input[type="password"]:focus { border-color: var(--p-accent); }
      .identity-status { font-size: 12px; min-height: 16px; display: flex; align-items: center; gap: 6px; }
      .identity-status.error { color: var(--p-danger); }
      .identity-status.ok    { color: var(--p-accent-ink); }
      .identity-status.spin  { color: var(--p-ink-2); }
      .status-dot { display: inline-block; width: 8px; height: 8px; flex-shrink: 0; }
      .status-dot.ok { background: var(--p-ok); }
      .identity-divider { display: flex; align-items: center; gap: 8px; color: var(--p-ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin: 4px 0; font-family: var(--p-mono); }
      .identity-divider::before, .identity-divider::after { content: ""; flex: 1; height: 1px; background: var(--p-rule); }
      .key-backup-box { font-family: var(--p-mono); font-size: 13px; color: var(--p-ink); background: var(--p-surface-2); border: 1px solid var(--p-rule); padding: 12px; word-break: break-all; user-select: all; line-height: 1.5; }
      .key-ack { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--p-ink-2); cursor: pointer; }
      .key-ack input { cursor: pointer; }
      .key-label { font-size: 11px; font-weight: 600; color: var(--p-ink-3); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 4px; font-family: var(--p-mono); }
      .key-reveal { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
      .choice-card { display: block; width: 100%; text-align: left; background: var(--p-surface-2); border: 1px solid var(--p-rule); padding: 14px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
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
        padding: 12px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .settings-card.warning { background: var(--p-warn-bg); border-color: var(--p-warn-border); }
      .card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .card-label { font-size: 11px; color: var(--p-ink-3); text-transform: uppercase; letter-spacing: 0.5px; font-family: var(--p-mono); }
      .card-title { font-size: 13px; font-weight: 600; color: var(--p-warn-ink); }
      .card-desc  { font-size: 12px; color: var(--p-ink-2); line-height: 1.5; }
      .card-value { font-size: 13px; color: var(--p-ink); }
      .card-value.ok { color: var(--p-accent-ink); }
      .relay-readout {
        font-size: 11px; color: var(--p-ink-2); font-family: var(--p-mono);
        background: var(--p-surface-2); padding: 6px 8px;
        white-space: pre-line; word-break: break-all; line-height: 1.6;
      }
      .profile-identity { display: flex; flex-direction: column; gap: 4px; }
      .profile-name { font-size: 13px; font-weight: 600; color: var(--p-accent-ink); word-break: break-all; }
      .profile-id { font-size: 12px; color: var(--p-ink-2); font-family: var(--p-mono); background: var(--p-surface-2); padding: 6px 8px; word-break: break-all; }
      .profile-id + .profile-id { margin-top: 4px; }
      .profile-id-label { color: var(--p-ink-3); margin-right: 6px; font-family: var(--p-font-sans, inherit); }
      .usage-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--p-ink-2); }
      .usage-row-link { background: none; border: none; width: 100%; cursor: pointer; padding: 2px 4px; margin: -2px -4px; transition: background 0.15s; font-family: inherit; }
      .usage-row-link:hover { background: var(--p-surface-2); color: var(--p-ink); }
      .usage-row-link:hover .usage-value { color: var(--p-accent-ink); }
      .usage-value { color: var(--p-ink); font-weight: 600; }
      /* Icon + text as one flex item so space-between still pushes the count right. */
      .usage-label { display: inline-flex; align-items: center; gap: 6px; }
      .pin-unlock summary { font-size: 12px; color: var(--p-ink-3); cursor: pointer; }
      .pin-row { display: flex; gap: 6px; margin-top: 6px; }
      .pin-row input { flex: 1; background: var(--p-surface); border: 1px solid var(--p-rule); color: var(--p-ink); font-size: 12px; padding: 6px 8px; outline: none; }
      .pin-row .btn { padding: 6px 10px; font-size: 12px; }
      .pin-error { font-size: 12px; color: var(--p-danger); margin-top: 4px; }
      .toggle-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
      .toggle-row input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; accent-color: var(--p-accent); width: 14px; height: 14px; cursor: pointer; }
      .toggle-label { display: flex; flex-direction: column; gap: 2px; }
      .toggle-title { font-size: 12px; color: var(--p-ink); }
      .toggle-desc  { font-size: 11px; color: var(--p-ink-3); line-height: 1.45; }

      /* Loading overlay */
      .loading {
        position: absolute; inset: 0;
        background: var(--p-veil);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 14px;
        /* Sit above the publish-mode slider segs (z-index:1) which would
           otherwise poke through the saving/success/error veil. */
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
      .success { color: var(--p-accent-ink); font-size: 18px; font-weight: 600; font-family: var(--p-mono); }
      .error   { color: var(--p-danger); font-size: 18px; font-weight: 600; font-family: var(--p-mono); }
      /* Inline ICON_CAST / ICON_CLIP beside status text and in the settings usage rows.
         They carry .seg-icon (sized 15px for the slider), so re-size here and win on
         specificity. currentColor means they take the success amber / error red of the
         line they sit in — which an emoji could never do. */
      .status-icon { display: inline-flex; align-items: center; vertical-align: -0.12em; }
      .status-icon .seg-icon { width: 1em; height: 1em; flex: none; }
      /* Both-mode pairs two glyphs; overlap slightly so they read as one unit,
         matching #seg-both on the slider. */
      .status-icon .seg-icon + .seg-icon { margin-left: -0.13em; }
      .open-library-btn, .open-discern-btn {
        margin-top: 10px; background: none; border: none; padding: 0;
        color: var(--p-accent-ink); font-size: 13px; cursor: pointer; text-decoration: underline;
      }
      .open-library-btn:hover, .open-discern-btn:hover { color: var(--p-accent); }
      .dismiss-btn {
        margin-top: 8px; background: none; border: none; padding: 0;
        color: var(--p-ink-3); font-size: 12px; cursor: pointer; text-decoration: underline;
      }
      .dismiss-btn:hover { color: var(--p-ink); }

      /* Inline stored-key unlock (footer link) */
      .inline-unlock { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
      .inline-unlock .pin-input { flex: 1; min-width: 100px; }
      .inline-unlock .btn { padding: 6px 10px; font-size: 12px; }
      .inline-unlock-error { font-size: 12px; color: var(--p-danger); width: 100%; }
      .pin-input {
        background: var(--p-surface); border: 1px solid var(--p-rule);
        color: var(--p-ink); font-size: 13px; padding: 8px 10px;
        outline: none; transition: border-color 0.15s; font-family: inherit;
      }
      .pin-input:focus { border-color: var(--p-accent); }

      /* Inline unlock-and-cast prompt (in the #loading panel) */
      .unlock-prompt { display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: 100%; max-width: 280px; }
      .unlock-title { color: var(--p-ink); font-size: 14px; font-weight: 600; text-align: center; }
      .unlock-actions { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .unlock-actions .btn-clip { width: 100%; }
    `;
  }
}

