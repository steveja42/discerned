// Opt-in visual harness for the extension's evaluation overlay (OVERLAY=1).
// Loads a fixture page in real Chromium with the dist-test extension, triggers
// ACTIVATE_DISCERNED through the extension service worker (the same path the
// toolbar click uses), and screenshots the rendered panel. The overlay lives in
// a closed shadow root, so this is a bitmap artifact for human review — no
// pixel baseline. Run:
//   OVERLAY=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=overlay-visual

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';

const OUT_DIR = resolve(__dirname, '..', '..', 'test-output');
const FIXTURE_URL = 'http://127.0.0.1:4173/blog-post.html';

test.describe('overlay visual', () => {
  test.skip(!process.env.OVERLAY, 'opt-in: set OVERLAY=1');
  test.setTimeout(60_000);

  test('renders the Signal + Qualifiers evaluation panel (unrated)', async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const { ctx } = await launchWithExtension();
    try {
      const page = await ctx.newPage();
      await page.goto(FIXTURE_URL, { waitUntil: 'load' });
      // Content script binds its message listener at document_idle.
      await page.waitForTimeout(500);

      // The MV3 service worker may not have spun up yet — nudge it via the page
      // context, then message the active tab the same way the toolbar click does.
      let [sw] = ctx.serviceWorkers();
      if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
      // Target the fixture tab by URL — the context's initial blank tab can
      // still be the "active" one, and it has no content script to receive us.
      const activate = () =>
        sw!.evaluate(async (fixtureUrl) => {
          const [tab] = await chrome.tabs.query({ url: `${fixtureUrl}*` });
          if (!tab?.id) throw new Error(`no tab matching ${fixtureUrl}`);
          await chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_DISCERNED' });
        }, FIXTURE_URL);

      // 1. Fresh guest profile → connect gate.
      await activate();
      // Host div is in the light DOM even though the panel is a closed shadow root.
      await expect(page.locator('#discerned-overlay')).toBeAttached({ timeout: 10_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: resolve(OUT_DIR, 'overlay-gate.png') });

      // 2. Dismiss the nudge via storage → main evaluation view (Signal + Qualifiers).
      await sw.evaluate(() => chrome.storage.local.set({ overlayNudgeDismissed: true }));
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(500);
      await activate();
      await expect(page.locator('#discerned-overlay')).toBeAttached({ timeout: 10_000 });
      // Give the panel time to finish its async capture + preview render.
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: resolve(OUT_DIR, 'overlay-main-unrated.png') });
    } finally {
      await ctx.close();
    }
  });
});
