// Helper for launching a Chromium persistent context with the built Discerned
// extension loaded. Used by extension.spec.ts and end-to-end.spec.ts.

import { chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// Always load from dist-test/ so the e2e suite never touches your local dev
// install in dist/. `pnpm build:test` (the e2e pretest hook) writes here.
export const EXTENSION_PATH = resolve(__dirname, '..', '..', '..', 'discerned-ext', 'dist-test');

// Root for reusable browser profiles. Gitignored at .vscode/browser-test-profiles/.
// Subdirs named 'test', 'medium', etc. let specs share login state across runs.
const PROFILES_ROOT = resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles');

export interface ExtensionContext {
  ctx: BrowserContext;
  userDataDir: string;
}

export interface LaunchOptions {
  /** Profile name under .vscode/browser-test-profiles/. Persistent across runs
   *  so logins/cookies stick. Omit for a throwaway temp profile. */
  profile?: string;
  /** Visible window mode. Default: respects PWDEBUG_HEADED env var. */
  headed?: boolean;
}

export async function launchWithExtension(opts: LaunchOptions = {}): Promise<ExtensionContext> {
  const userDataDir = opts.profile
    ? (() => { const d = resolve(PROFILES_ROOT, opts.profile!); mkdirSync(d, { recursive: true }); return d; })()
    : mkdtempSync(join(tmpdir(), 'discerned-e2e-'));
  // Headed when explicitly requested OR when PWDEBUG_HEADED=1 is set; otherwise
  // use --headless=new (works on modern Chromium, suppresses windows on CI/local).
  const headed = opts.headed ?? !!process.env.PWDEBUG_HEADED;
  // A realistic Chrome user-agent string (Stable channel as of 2026). Sites
  // like Cloudflare-protected ones reject the Playwright-default UA which
  // self-identifies as "HeadlessChrome".
  const REAL_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    // headless: false with --headless=new in args is the Playwright-recommended
    // shape for headless extension loading; Playwright's own headless mode
    // (headless: true) uses a different binary that doesn't load extensions.
    headless: false,
    userAgent: REAL_UA,
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      ...(headed ? [] : ['--headless=new']),
      '--no-sandbox',
      '--no-first-run',
      '--disable-features=DialMediaRouteProvider',
      // Mute all tab audio so headed runs against YouTube / streaming sites
      // don't blast the user's speakers.
      '--mute-audio',
      // Anti-detection: strip the Blink flag that exposes automation, drop
      // the "Chrome is being controlled by automated test software" infobar
      // fingerprint, and silence the testing-mode badge. Cloudflare's
      // Turnstile reads these to flag the browser as a bot.
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',
      '--disable-infobars',
    ],
    viewport: { width: 1280, height: 720 },
  });

  // Hide the most common automation tells from page JS:
  //   - navigator.webdriver should be undefined (Playwright sets it to true)
  //   - navigator.plugins should be non-empty
  //   - navigator.languages should be a real array
  //   - window.chrome should expose a runtime object (Chrome's own page JS expects it)
  // Runs on every new page in this context before any page script.
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    } catch { /* best effort */ }
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    } catch { /* best effort */ }
    try {
      // A tiny synthetic plugins array — Cloudflare doesn't inspect the
      // contents, only that the length is non-zero.
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'PDF Viewer' })),
        configurable: true,
      });
    } catch { /* best effort */ }
  });

  return { ctx, userDataDir };
}
