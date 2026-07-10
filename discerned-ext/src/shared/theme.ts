// Role: Shared — theme token registry + resolution helpers
// Description: Single source of truth for the extension's colour themes. Each theme
//              is a map of CSS custom properties (design tokens) consumed by every UI
//              surface — the overlay + preview card + error toast (shadow roots) and
//              the standalone popup/onboarding/connect pages (:root). Adding a theme
//              is: one new THEME_TOKENS entry here + widening Theme/ResolvedTheme in
//              types.ts + one picker chip in the overlay settings drawer.
// Access: pure data + DOM helpers. prefersDark/onSystemThemeChange guard matchMedia;
//         initPageTheme touches chrome.storage + document (standalone pages only).

import {
  STORAGE_KEYS,
  resolveThemePref,
  resolveEffectiveTheme,
  type Theme,
  type ResolvedTheme,
} from '@/shared/types';

/**
 * Design tokens per theme.
 * - `dark` reproduces the current "Dark zinc" palette EXACTLY, so switching the
 *   overlay onto this registry leaves dark mode pixel-unchanged.
 * - `light` is the former "Jakarta Blue (translucent)" palette (recovered from
 *   git history — the scheme that predated dark-zinc), extended with the extra
 *   semantic tokens the overlay needs (focus ring, status colours, panel shell).
 */
export const THEME_TOKENS: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    'color-scheme':    'dark',
    '--p-bg':          'rgba(9, 9, 11, 0.92)',
    '--p-surface':     '#18181b',
    '--p-surface-2':   '#27272a',
    '--p-ink':         '#f4f4f5',
    '--p-ink-2':       '#d4d4d8',
    '--p-ink-3':       '#a1a1aa',
    '--p-ink-4':       '#52525b',
    '--p-rule':        '#3f3f46',
    '--p-rule-soft':   '#27272a',
    '--p-accent':      '#f59e0b',
    '--p-accent-ink':  '#fbbf24',
    '--p-on-accent':   '#09090b',
    '--p-cta-bg':      '#f4f4f5',
    '--p-cta-ink':     '#09090b',
    '--p-cta-shadow':  'rgba(0, 0, 0, 0.60)',
    '--p-mono':        'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    // Semantic tokens — were hardcoded literals scattered through the CSS before theming.
    '--p-focus-ring':   'rgba(245, 158, 11, 0.18)',
    '--p-warn-ink':     '#fbbf24',
    '--p-warn-bg':      'rgba(245, 158, 11, 0.12)',
    '--p-warn-border':  'rgba(245, 158, 11, 0.40)',
    '--p-connected':    '#a855f7',
    '--p-ok':           '#4ade80',
    '--p-danger':       '#f87171',
    '--p-cta-bg-hover': '#ffffff',
    '--p-surface-solid':'rgba(24, 24, 27, 0.97)',
    // Fully-opaque card surface for free-floating elements (preview card, toast)
    // that sit over arbitrary page content WITHOUT a backdrop blur — a translucent
    // surface would let page text bleed through them.
    '--p-card':         '#18181b',
    '--p-veil':         'rgba(9, 9, 11, 0.92)',
    '--p-panel-opaque': '#09090b',
    '--p-panel-border': '#3f3f46',
    '--p-panel-shadow': '24px 0 60px -20px rgba(0, 0, 0, 0.60)',
  },
  light: {
    'color-scheme':    'light',
    '--p-bg':          'rgba(167, 192, 235, 0.55)',
    '--p-surface':     'rgba(231, 238, 251, 0.65)',
    '--p-surface-2':   'rgba(202, 217, 244, 0.70)',
    '--p-ink':         '#0f172a',
    '--p-ink-2':       '#1e293b',
    '--p-ink-3':       '#475569',
    '--p-ink-4':       '#94a3b8',
    '--p-rule':        'rgba(15, 23, 42, 0.18)',
    '--p-rule-soft':   'rgba(15, 23, 42, 0.10)',
    '--p-accent':      'oklch(0.55 0.21 263)',
    '--p-accent-ink':  'oklch(0.49 0.21 263)',
    '--p-on-accent':   '#eef4ff',
    '--p-cta-bg':      '#1e3a8a',
    '--p-cta-ink':     '#eaf1ff',
    '--p-cta-shadow':  'rgba(30, 58, 138, 0.40)',
    '--p-mono':        'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    '--p-focus-ring':   'rgba(37, 99, 235, 0.15)',
    '--p-warn-ink':     '#8a5a00',
    '--p-warn-bg':      'rgba(217, 119, 6, 0.12)',
    '--p-warn-border':  'rgba(217, 119, 6, 0.35)',
    '--p-connected':    '#7c3aed',
    '--p-ok':           '#16a34a',
    '--p-danger':       '#dc2626',
    '--p-cta-bg-hover': '#17306e',
    '--p-surface-solid':'rgba(231, 238, 251, 0.97)',
    '--p-card':         '#e7eefb',
    '--p-veil':         'rgba(220, 231, 249, 0.92)',
    '--p-panel-opaque': '#dde7f9',
    '--p-panel-border': 'rgba(255, 255, 255, 0.40)',
    '--p-panel-shadow': '24px 0 60px -20px rgba(30, 58, 138, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.5)',
  },
};

/**
 * Serialize a theme's tokens into declarations for a `:host { … }` (shadow root)
 * or `:root { … }` (page) rule. Indented 8 spaces to match the overlay's
 * template-literal CSS; leading whitespace is irrelevant to CSS anyway.
 */
export function themeVarsBlock(theme: ResolvedTheme): string {
  return Object.entries(THEME_TOKENS[theme])
    .map(([prop, value]) => `        ${prop}: ${value};`)
    .join('\n');
}

/** True when the OS reports a dark colour-scheme preference. */
export function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Subscribe to OS light/dark changes. Returns an unsubscribe function.
 * No-op (returns a no-op disposer) in contexts without matchMedia.
 */
export function onSystemThemeChange(cb: (isDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => { /* no matchMedia — nothing to unsubscribe */ };
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/**
 * Bootstrap theming for a standalone extension page (popup / onboarding / connect).
 * Injects the active theme's tokens into `:root` via a `<style id="dx-theme-vars">`
 * (appended after the page's own inline styles, so it wins the cascade), then keeps
 * them in sync with the stored preference and OS changes. Call once at page load.
 */
export function initPageTheme(): void {
  const apply = (theme: ResolvedTheme) => {
    let styleEl = document.getElementById('dx-theme-vars') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'dx-theme-vars';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `:root {\n${themeVarsBlock(theme)}\n}`;
    document.documentElement.dataset.theme = theme;
  };

  let pref: Theme = 'system';
  const refresh = () => apply(resolveEffectiveTheme(pref, prefersDark()));

  // Provisional apply immediately (before storage resolves) to minimise flash.
  refresh();

  void chrome.storage.local.get(STORAGE_KEYS.THEME).then((s) => {
    pref = resolveThemePref(s[STORAGE_KEYS.THEME] as string | undefined);
    refresh();
  }).catch(() => { /* keep provisional */ });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(STORAGE_KEYS.THEME in changes)) return;
    pref = resolveThemePref(changes[STORAGE_KEYS.THEME]?.newValue as string | undefined);
    refresh();
  });

  onSystemThemeChange(() => { if (pref === 'system') refresh(); });
}
