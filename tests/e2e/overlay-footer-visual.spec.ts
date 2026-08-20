// Temporary: renders the footer in both themes, connected and guest, to check
// the publish-mode slider's new prominence and the panel's height budget.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';

const OUT_DIR = resolve(__dirname, '..', '..', 'test-output');
const FIXTURE_URL = 'http://127.0.0.1:4173/blog-post.html';
const VH = Number(process.env.VH || 660);

for (const theme of ['light', 'dark'] as const) {
  test.describe(`overlay footer ${theme}`, () => {
    test.skip(!process.env.FOOTER, 'opt-in: set FOOTER=1');
    test.setTimeout(90_000);

    test(`renders in ${theme}`, async () => {
      mkdirSync(OUT_DIR, { recursive: true });
      const { ctx } = await launchWithExtension();
      try {
        const page = await ctx.newPage();
        await page.setViewportSize({ width: 1280, height: VH });
        await page.goto(FIXTURE_URL, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        let [sw] = ctx.serviceWorkers();
        if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
        await sw.evaluate((t) => chrome.storage.local.set({
          overlayNudgeDismissed: true, theme: t,
        }), theme);
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(400);
        await sw.evaluate(async (u) => {
          const [tab] = await chrome.tabs.query({ url: `${u}*` });
          await chrome.tabs.sendMessage(tab!.id!, { type: 'ACTIVATE_DISCERNED' });
        }, FIXTURE_URL);
        await expect(page.locator('#discerned-overlay')).toBeAttached({ timeout: 10_000 });
        await page.waitForTimeout(1_600);
        await page.screenshot({ path: resolve(OUT_DIR, `footer-${theme}.png`) });
      } finally {
        await ctx.close();
      }
    });
  });
}
