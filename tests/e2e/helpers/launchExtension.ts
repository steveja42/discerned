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
  // Chromium MV3 extensions historically don't load in --headless=new on every
  // Chromium build; an unspecified headless flag with Playwright's own headed
  // mode is the most reliable shape. If you need true headless on CI, set
  // PWDEBUG_HEADLESS_NEW=1 to opt in.
  const headlessNew = !!process.env.PWDEBUG_HEADLESS_NEW;
  const ctx = await chromium.launchPersistentContext(userDataDir, {
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
