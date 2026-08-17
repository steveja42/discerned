// One-shot tool: save the logged-in Facebook home feed as a deterministic
// fixture, so the post-card boundary can be worked out OFFLINE.
//
// Why this exists: four attempts to make tagFacebook capture the author byline
// were written against the LIVE feed and all four made the clip worse. The feed
// serves a DIFFERENT post shape on every load — plain, shared (two nested
// bylines), tagged ("X was tagged", header above the card) — so a rule that
// looked right on one load broke on the next. A fixture freezes all three
// shapes in one tree.
//
// Images are inlined as data URIs through the page's own session (fbcdn rejects
// unauthenticated fetches), and scripts are stripped so the fixture is inert.
//
// Run (Chrome fully closed, logged-in warm profile):
//   FBSNAP=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=snapshot-facebook-feed

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const FEED_URL = process.env.FB_URL ?? 'https://www.facebook.com/';
const FIXTURE_PATH = resolve(__dirname, '..', '..', 'fixtures', 'sites', 'facebook-feed.html');

test('snapshot-facebook-feed', async () => {
  test.skip(!process.env.FBSNAP, 'set FBSNAP=1 to run');
  test.setTimeout(300_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.PWDEBUG_HEADED,
  });
  try {
    const page = await ctx.newPage();
    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(9_000);

    // Dismiss the "Remember Password" / cookie interstitials that cover the feed.
    for (const label of ['Not Now', 'Not now', 'Decline optional cookies', 'Close']) {
      const btn = page.getByRole('button', { name: label, exact: false }).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(1_000);
      }
    }

    // Scroll to accumulate SEVERAL posts so the fixture covers multiple shapes
    // (plain / shared / tagged) rather than whichever one happens to load first.
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(1_800);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2_000);

    const shapes = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll(
        '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]'));
      const bodyTxt = (document.body.innerText ?? '');
      return {
        storyMessages: msgs.length,
        looksTagged: /was tagged|is with /i.test(bodyTxt),
        looksShared: /shared a (post|link|memory)/i.test(bodyTxt),
      };
    });
    // eslint-disable-next-line no-console
    console.log(`[fb-snap] story messages: ${shapes.storyMessages} tagged=${shapes.looksTagged} shared=${shapes.looksShared}`);

    // Inline images through the page session (fbcdn 403s an anonymous fetch).
    const inlined = await page.evaluate(async () => {
      const MAX_BYTES = 150 * 1024;
      const DOWNSCALE = 256;
      let ok = 0, skip = 0;
      async function downscale(blob: Blob): Promise<string | null> {
        try {
          const bmp = await createImageBitmap(blob);
          const scale = Math.min(1, DOWNSCALE / bmp.width);
          const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
          const canvas = new OffscreenCanvas(w, h);
          const c2d = canvas.getContext('2d');
          if (!c2d) return null;
          c2d.drawImage(bmp, 0, 0, w, h);
          const out = await canvas.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await out.arrayBuffer());
          let bin = ''; const chunk = 8192;
          for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
          return `data:image/png;base64,${btoa(bin)}`;
        } catch { return null; }
      }
      for (const img of Array.from(document.querySelectorAll('img'))) {
        const src = img.getAttribute('src');
        if (!src || src.startsWith('data:')) { skip++; continue; }
        try {
          const r = await fetch(src, { credentials: 'include', cache: 'no-cache' });
          if (!r.ok) { skip++; continue; }
          const blob = await r.blob();
          const ct = r.headers.get('content-type') || 'image/jpeg';
          let uri: string | null = null;
          if (blob.size > MAX_BYTES || ct.includes('gif')) uri = await downscale(blob);
          if (!uri) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let bin = ''; const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
            uri = `data:${ct};base64,${btoa(bin)}`;
          }
          img.setAttribute('src', uri);
          img.removeAttribute('srcset');
          ok++;
        } catch { skip++; }
      }
      return { ok, skip };
    });
    // eslint-disable-next-line no-console
    console.log(`[fb-snap] inlined ${inlined.ok} imgs (skipped ${inlined.skip})`);

    // Strip scripts / external links so the fixture is inert and offline-safe.
    const html = await page.evaluate(() => {
      document.querySelectorAll('script, link[rel="preload"], link[rel="prefetch"]').forEach(n => n.remove());
      return '<!doctype html>\n' + document.documentElement.outerHTML;
    });
    writeFileSync(FIXTURE_PATH, html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[fb-snap] wrote ${FIXTURE_PATH} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    await ctx.close();
  }
});
