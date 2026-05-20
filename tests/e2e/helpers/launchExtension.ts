// Helper for launching a Chromium persistent context with the built Discerned
// extension loaded. Used by extension.spec.ts and end-to-end.spec.ts.

import { chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// Always load from dist-test/ so the e2e suite never touches your local dev
// install in dist/. `pnpm build:test` (the e2e pretest hook) writes here.
export const EXTENSION_PATH = resolve(__dirname, '..', '..', '..', 'discerned-ext', 'dist-test');

export interface ExtensionContext {
  ctx: BrowserContext;
  userDataDir: string;
}

export async function launchWithExtension(): Promise<ExtensionContext> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'discerned-e2e-'));
  // Use --headless=new by default (works on modern Chromium and suppresses
  // browser windows during CI and local test runs). Set PWDEBUG_HEADED=1 to
  // open a visible window for debugging.
  const headlessNew = !process.env.PWDEBUG_HEADED;
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    // headless: false with --headless=new in args is the Playwright-recommended
    // shape for headless extension loading; Playwright's own headless mode
    // (headless: true) uses a different binary that doesn't load extensions.
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      ...(headlessNew ? ['--headless=new'] : []),
      '--no-sandbox',
      '--no-first-run',
      '--disable-features=DialMediaRouteProvider',
    ],
    viewport: { width: 1280, height: 720 },
  });
  return { ctx, userDataDir };
}
