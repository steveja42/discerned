// Live visual-parity check for Facebook single-post URLs (reel, photo
// permalink) via extractFacebookPost's Tier-0 gate. Requires the warm,
// logged-in Chrome profile — Facebook content is not visible logged out.
//
// Uses activateExtensionOnPage (not activateExtensionOnTab): Facebook
// redirects and appends tracking params, so a URL-prefix match against the
// originally-requested URL fails once the page settles.
//
// Run (Chrome fully closed):
//   FB_LIVE=1 PWDEBUG_HEADED=1 pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=facebook-visual
// Options: FB_LIVE_URL=<a specific post URL to test instead of both defaults>

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnPage } from './helpers/activateExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody, screenshotSourcePage } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';
import { liveArtifacts } from './helpers/liveArtifacts';
import { refreshLiveGallery } from './helpers/liveGallery';

const DEFAULT_URLS: Array<{ slug: string; url: string }> = [
  { slug: 'facebook-reel', url: 'https://www.facebook.com/reel/4460125307635536' },
  { slug: 'facebook-photo', url: 'https://www.facebook.com/photo/?fbid=2915603832116944' },
];

const TARGETS = process.env.FB_LIVE_URL
  ? [{ slug: 'facebook-post', url: process.env.FB_LIVE_URL }]
  : DEFAULT_URLS;

test.describe.configure({ mode: 'serial' });

for (const { slug, url } of TARGETS) {
  test(`facebook-visual: ${slug} — capture, render in /clips, screenshot`, async () => {
    test.skip(!process.env.FB_LIVE, 'set FB_LIVE=1 to run');
    test.setTimeout(240_000);

    const outDir = resolve(__dirname, '..', '..', 'test-output');
    mkdirSync(outDir, { recursive: true });
    const live = liveArtifacts(slug);

    const { ctx } = await launchWithExtension({
      rawUserDataDir: resolve(__dirname, '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
      profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
      channel: 'chrome', preinstalledExtension: true,
      headed: process.env.PWDEBUG_HEADED === '0' ? false : true,
    });
    try {
      const page = await ctx.newPage();
      page.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('Discerned') || t.includes('dx-')) {
          // eslint-disable-next-line no-console
          console.log(`[browser:${msg.type()}]`, t);
        }
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForTimeout(6_000);

      // Dismiss the "Remember Password" / cookie interstitials that cover the post.
      for (const label of ['Not Now', 'Not now', 'Decline optional cookies', 'Close']) {
        const btn = page.getByRole('button', { name: label, exact: false }).first();
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 3_000 }).catch(() => undefined);
          await page.waitForTimeout(1_000);
        }
      }
      await page.waitForTimeout(2_000);
      await screenshotSourcePage(page, live.source());

      await activateExtensionOnPage(page);

      const cap = (await page.evaluate(async () => {
        return new Promise((resolveCap, rejectCap) => {
          const timer = setTimeout(() => rejectCap(new Error('capture timeout')), 30_000);
          const onMessage = (e: MessageEvent) => {
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            if (e.data.error) rejectCap(new Error(e.data.error));
            else resolveCap(e.data.capture);
          };
          window.addEventListener('message', onMessage);
          window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
        });
      })) as Record<string, unknown>;

      writeFileSync(
        resolve(outDir, `${slug}-live-capture.json`),
        JSON.stringify(
          { ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').replace(/data:image\/[^"]+/g, 'IMG_INLINED') },
          null, 2,
        ),
        'utf8',
      );

      const libPage = await ctx.newPage();
      await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
      const postClip = () => libPage.evaluate((capture) => {
        const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
        window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
        window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
      }, cap);

      const row = libPage.locator('article.clip').first();
      let rowVisible = false;
      for (let attempt = 0; attempt < 4 && !rowVisible; attempt++) {
        await postClip();
        try {
          await row.waitFor({ state: 'visible', timeout: 8_000 });
          rowVisible = true;
        } catch { /* bridge race — re-post and retry */ }
      }
      await row.click();

      const clipBody = libPage.locator('.clip-body');
      await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
      await libPage.waitForTimeout(1000);

      await screenshotClipBody(libPage, clipBody, live.clip());

      // Third artifact: the PUBLIC cast render (kind-30023 markdown), built by
      // the extension's real BUILD_CAST path from this same capture.
      await castShotSafe(page, cap as { title?: string }, live.cast());

      // Structural health checks (after screenshots so artifacts survive a fail).
      await assertClipBodyHealth(clipBody);

      // eslint-disable-next-line no-console
      console.log(`\n✓ Saved ${slug}-* artifacts to ${outDir}\n`);
    } finally {
      await ctx.close();
      refreshLiveGallery();
    }
  });
}
