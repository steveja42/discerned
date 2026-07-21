// Helper for launching a Chromium persistent context with the built Discerned
// extension loaded. Used by extension.spec.ts and end-to-end.spec.ts.

import { chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// A persistent profile caches the extension's MV3 service worker SCRIPT keyed by
// extension id + version. Reloading the unpacked extension from disk does NOT
// hot-swap a still-registered SW, so a persistent profile keeps answering with
// the PREVIOUS background build after a `pnpm build:test` — silently breaking any
// new background message handler (observed: BUILD_CAST → "Unknown message type"
// on the `test` profile while a throwaway profile worked). Clearing these cache
// dirs before launch forces Chrome to re-register the SW from the current
// dist-test. Cookies / Login Data / Local Storage are left intact so site logins
// (Cloudflare, etc.) survive.
// SW/cache subdirs, RELATIVE to a profile folder. Chrome nests them under the
// profile dir — 'Default' for a fresh/throwaway profile, or a named sub-profile
// like 'Profile 3' inside a real …\User Data dir.
const SW_CACHE_SUBDIRS = [
  'Service Worker',
  'Code Cache',
  'Extension State',
  'Extension Rules',
  'Extension Scripts',
  'GPUCache',
];

// Clear the SW/code cache under `userDataDir/<profileFolder>`. profileFolder
// defaults to 'Default' (throwaway/named-under-PROFILES_ROOT profiles); pass the
// real sub-profile ('Profile 3') for a rawUserDataDir. Cookies / Local Storage /
// Network are NOT under these subdirs, so cf_clearance + logins survive.
function clearServiceWorkerCache(userDataDir: string, profileFolder = 'Default'): void {
  for (const sub of SW_CACHE_SUBDIRS) {
    try {
      rmSync(resolve(userDataDir, profileFolder, sub), { recursive: true, force: true });
    } catch { /* best effort — dir may not exist */ }
  }
}

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
  /**
   * Launch against a REAL browser user-data-dir (e.g. `…\Google\Chrome\User Data`)
   * to inherit an existing Cloudflare `cf_clearance` cookie so CF-walled sites
   * (Medium, Stack Overflow) load. The browser owning this dir MUST be fully
   * closed (Chromium enforces a single-instance lock). Pair with
   * `profileDirectory` to select the sub-profile and `channel: 'chrome'` to use
   * the installed Chrome binary (matching the fingerprint CF cleared).
   * The SW cache is NOT cleared for a raw dir — it's a real profile.
   *
   * Also settable via env: RAW_USER_DATA_DIR / PROFILE_DIR / BROWSER_CHANNEL,
   * so any existing spec can be pointed at a warm profile without code changes.
   */
  rawUserDataDir?: string;
  /** `--profile-directory` value (e.g. "Profile 3"). Only meaningful with rawUserDataDir. */
  profileDirectory?: string;
  /** Playwright browser channel, e.g. 'chrome' for the installed Chrome. */
  channel?: 'chrome' | 'msedge' | 'chrome-beta';
  /**
   * The Discerned extension is ALREADY installed in this profile (you did
   * chrome://extensions → Load unpacked → dist-test once, by hand). When true we
   * launch a plain persistent context on the given `channel` and do NOT try to
   * load the extension ourselves — neither the `--load-extension` flag (Chrome
   * 137+ ignores it on branded builds) nor the CDP `Extensions.loadUnpacked` path
   * (which loads the extension but never injects its content scripts). A
   * manually-installed unpacked extension is exempt from both problems: its
   * content scripts inject normally, and the launch carries none of the automation
   * tells (`--enable-unsafe-extension-debugging`, a CDP-loaded extension) that
   * Cloudflare flags. This is the ONLY combination that gets past Cloudflare AND
   * runs the extension. Requires `channel` (real Chrome) + a persistent profile
   * dir (via `profile` or `rawUserDataDir`).
   *
   * Also settable via env: PREINSTALLED_EXT=1.
   */
  preinstalledExtension?: boolean;
  /**
   * Force the extension's service worker to re-register from the current
   * dist-test even on a rawUserDataDir. By default the SW cache is NEVER touched
   * for a raw dir (it's treated as the user's real profile). But the named test
   * profiles under .vscode/browser-test-profiles/ ARE reached via rawUserDataDir
   * (e.g. Profile 3), and MV3 caches the background SW script keyed by ext id +
   * version — so after a `pnpm build:test` a background-code change (a new
   * BUILD_CAST handler, a fix in createLongFormEvent) keeps being served STALE,
   * silently. This clears ONLY the SW/Code-Cache dirs (Cookies / Local Storage /
   * Network — including cf_clearance — are left intact), so a test profile picks
   * up current background code. Only opt into this for the dedicated test
   * profiles, never a genuine user profile.
   *
   * Also settable via env: CLEAR_SW_CACHE=1.
   */
  clearSwCacheForRawDir?: boolean;
}

export async function launchWithExtension(opts: LaunchOptions = {}): Promise<ExtensionContext> {
  // Env-var override so any spec can target a warm real-browser profile without
  // editing it: RAW_USER_DATA_DIR="…\User Data" PROFILE_DIR="Profile 3" BROWSER_CHANNEL=chrome
  if (process.env.RAW_USER_DATA_DIR) {
    opts = {
      ...opts,
      rawUserDataDir: process.env.RAW_USER_DATA_DIR,
      profileDirectory: process.env.PROFILE_DIR ?? opts.profileDirectory,
      channel: (process.env.BROWSER_CHANNEL as LaunchOptions['channel']) ?? opts.channel,
    };
  }
  // PREINSTALLED_EXT=1 opts into the manually-installed-extension path (see the
  // option's doc comment) without editing the spec.
  if (process.env.PREINSTALLED_EXT) opts = { ...opts, preinstalledExtension: true };
  // On a real branded channel we ALWAYS use the preinstalled path. The only other
  // real-channel option (CDP Extensions.loadUnpacked) loads the extension but never
  // injects content scripts, so it's useless for capture — and worse, the
  // flag-loaded path (--load-extension / --disable-extensions-except) actively
  // DEREGISTERS a manually-installed extension from the persistent profile, so a
  // single non-preinstalled run silently uninstalls it for every future run. Forcing
  // preinstalled here makes it impossible to clobber the hand-installed extension.
  const preinstalled = !!opts.preinstalledExtension || !!opts.channel;
  const usingRawDir = !!opts.rawUserDataDir;
  const userDataDir = usingRawDir
    ? opts.rawUserDataDir!
    : opts.profile
      ? (() => { const d = resolve(PROFILES_ROOT, opts.profile!); mkdirSync(d, { recursive: true }); return d; })()
      : mkdtempSync(join(tmpdir(), 'discerned-e2e-'));
  // Persistent profiles cache a stale extension SW after a rebuild — clear it so
  // the launch picks up the current dist-test background. Throwaway temp
  // profiles are already fresh, so this only matters (and only runs) for named
  // profiles, but it's cheap + harmless either way. NEVER for a raw real-browser
  // dir — we don't wipe caches out of the user's actual profile.
  if (opts.profile && !usingRawDir) clearServiceWorkerCache(userDataDir);
  // Named test profiles reached via rawUserDataDir (e.g. Profile 3) still cache a
  // stale background SW after a rebuild — opt-in clear (SW/code cache only; cookies
  // + cf_clearance preserved) so a build:test's background changes take effect.
  if (usingRawDir && (opts.clearSwCacheForRawDir || process.env.CLEAR_SW_CACHE)) {
    clearServiceWorkerCache(userDataDir, opts.profileDirectory ?? 'Default');
  }
  // Headed when explicitly requested OR when PWDEBUG_HEADED=1 is set; otherwise
  // use --headless=new (works on modern Chromium, suppresses windows on CI/local).
  const headed = opts.headed ?? !!process.env.PWDEBUG_HEADED;
  // A realistic Chrome user-agent string (Stable channel as of 2026). Sites
  // like Cloudflare-protected ones reject the Playwright-default UA which
  // self-identifies as "HeadlessChrome".
  const REAL_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  // Two launch shapes:
  //  - Bundled Chromium (no channel): loads the extension via the --load-extension
  //    flag, which bundled Chrome-for-Testing still honors. Used for the named
  //    `test` profile + throwaway profiles.
  //  - Real branded Chrome (channel set → preinstalled): Chrome 137+ ignores
  //    --load-extension on branded builds, so the extension must be installed in the
  //    profile by hand (chrome://extensions → Load unpacked) and we pass NO
  //    extension-loading flags. Passing --load-extension here would actively
  //    DEREGISTER that hand-installed extension, and --enable-unsafe-extension-
  //    debugging is a Cloudflare automation tell — so neither is used.
  const args = [
    ...(preinstalled
      ? []
      : [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
        ]),
    // Select the sub-profile inside a real …\User Data dir.
    ...(opts.profileDirectory ? [`--profile-directory=${opts.profileDirectory}`] : []),
    // A real, Google-signed-in profile kicks off sync + GCM registration on
    // launch; that chatter (ERROR …registration_request… DEPRECATED_ENDPOINT,
    // retried forever) stalls Playwright's launch handshake past its timeout.
    // None of it is needed for a capture run.
    ...(usingRawDir
      ? [
          '--disable-sync',
          '--disable-background-networking',
          '--disable-component-update',
          '--no-default-browser-check',
          '--disable-client-side-phishing-detection',
        ]
      : []),
    ...(headed ? [] : ['--headless=new']),
    // --no-sandbox is for Playwright's bundled Chromium / CI containers. On a
    // REAL installed Chrome it raises the yellow "You are using an unsupported
    // flag: no-sandbox" banner and the browser stalls instead of handing
    // Playwright a usable context — never pass it with a real channel.
    ...(opts.channel ? [] : ['--no-sandbox']),
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
    // --exclude-switches is a chromedriver concept, not a Chrome flag; real
    // Chrome flags it as unsupported. Only useful for bundled Chromium.
    ...(opts.channel ? [] : ['--exclude-switches=enable-automation']),
    '--disable-infobars',
  ];

  let ctx: BrowserContext;
  if (preinstalled) {
    // The extension is already installed in this persistent profile (manual
    // chrome://extensions → Load unpacked). Just launch a plain persistent context
    // on the real channel — no extension-loading flags, no CDP. This is the only
    // shape that both (a) injects content scripts (a manually-installed unpacked
    // extension is exempt from the Chrome-137 --load-extension block) and (b) gets
    // past Cloudflare (real branded Chrome, persistent cf_clearance, none of the
    // CDP/debugging automation tells). Requires channel + a persistent dir.
    if (!opts.channel) throw new Error('preinstalledExtension requires a real channel (e.g. channel: "chrome")');
    if (!opts.profile && !usingRawDir) throw new Error('preinstalledExtension requires a persistent profile dir (profile or rawUserDataDir)');
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: opts.channel,
      locale: 'en-US',
      // ignoreDefaultArgs strips Playwright defaults that would break this path:
      //  - --disable-extensions and --disable-component-extensions-with-background-
      //    pages: Playwright injects these by default, which turns OFF every
      //    extension in the profile — including the hand-installed Discerned one.
      //    Removing them is what lets the preinstalled extension actually run
      //    (verified: with them present, chrome://extensions shows ZERO extensions).
      //  - --enable-automation: the "controlled by test software" banner + internal
      //    automation flags Cloudflare reads. --exclude-switches doesn't work on a
      //    real channel, so ignoreDefaultArgs is how it's suppressed on branded Chrome.
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--enable-automation',
      ],
      args,
      viewport: { width: 1280, height: 720 },
    });
  } else {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      // headless: false with --headless=new in args is the Playwright-recommended
      // shape for headless extension loading; Playwright's own headless mode
      // (headless: true) uses a different binary that doesn't load extensions.
      headless: false,
      // Bundled Chromium self-reports "HeadlessChrome" in its UA — override with a
      // realistic Stable-channel string so Cloudflare-protected sites don't bounce it.
      userAgent: REAL_UA,
      locale: 'en-US',
      args,
      viewport: { width: 1280, height: 720 },
    });
  }

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
