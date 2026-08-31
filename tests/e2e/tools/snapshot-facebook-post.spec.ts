// One-shot tool: save a single Facebook post permalink (reel, photo, text
// post, Watch, or share link) as a deterministic fixture, so
// extractFacebookPost can be iterated on OFFLINE.
//
// Same rationale as snapshot-facebook-feed.spec.ts (the live page is
// non-deterministic across loads), but for a single post rather than the feed
// track. Images are inlined as data URIs through the page's own session
// (fbcdn rejects unauthenticated fetches), and scripts are stripped so the
// fixture is inert.
//
// Inlining is NOT optional housekeeping: fbcdn URLs carry expiring signed
// tokens (oh=/oe=), so any image left remote 403s within days and the fixture
// rots into a blank-photo capture. Two shapes must both be caught — <img src>
// AND the SVG <image xlink:href> Facebook uses for avatars.
//
// Run (Chrome fully closed, logged-in warm profile):
//   FBPOSTSNAP=1 FB_POST_URL=https://www.facebook.com/reel/4460125307635536 \
//     FB_SLUG=facebook-reel pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=snapshot-facebook-post

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const POST_URL = process.env.FB_POST_URL;
const SLUG = process.env.FB_SLUG ?? 'facebook-post';
const FIXTURE_PATH = resolve(__dirname, '..', '..', 'fixtures', 'sites', `${SLUG}.html`);

test('snapshot-facebook-post', async () => {
  test.skip(!process.env.FBPOSTSNAP, 'set FBPOSTSNAP=1 to run');
  test.skip(!POST_URL, 'set FB_POST_URL to the permalink/reel/photo URL to snapshot');
  test.setTimeout(300_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.PWDEBUG_HEADED,
  });
  try {
    const page = await ctx.newPage();
    await page.goto(POST_URL!, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(9_000);

    // Dismiss the "Remember Password" / cookie interstitials that cover the post.
    for (const label of ['Not Now', 'Not now', 'Decline optional cookies', 'Close']) {
      const btn = page.getByRole('button', { name: label, exact: false }).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(1_000);
      }
    }

    // For a reel/Watch player, nudge playback briefly so the <video> element
    // has decoded at least one frame (readyState >= 2) before we snapshot —
    // that's what the live captureVideoFrames canvas path needs, and it's
    // useful to freeze whatever poster/currentSrc state the player settles on.
    const hasVideo = await page.evaluate(() => document.querySelector('video') !== null);
    if (hasVideo) {
      await page.waitForTimeout(3_000);
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.muted = true; void v.play().catch(() => undefined); }
      });
      await page.waitForTimeout(2_000);
    }

    const shape = await page.evaluate(() => ({
      video: document.querySelectorAll('video').length,
      msgs: document.querySelectorAll(
        '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      imgs: document.querySelectorAll('img').length,
    }));
    // eslint-disable-next-line no-console
    console.log(`[fb-post-snap] shape: video=${shape.video} msgs=${shape.msgs} dialogs=${shape.dialogs} imgs=${shape.imgs}`);

    // Inline images as data URIs.
    //
    // Fetching from INSIDE the page does not work: facebook.com -> fbcdn.net is
    // cross-origin and fbcdn sends no CORS header, so every in-page fetch dies
    // with "TypeError: Failed to fetch" and the fixture silently saves with
    // 4x3 lazy-load stubs instead of real photos (measured: 1 of 39 inlined).
    // Fetch on the NODE side instead, via page.request — it reuses the
    // browser's cookies but is not subject to CORS. Same approach as
    // snapshot-bsky-post.spec.ts, for the same reason.
    const urls: string[] = await page.evaluate(() => {
      const out = new Set<string>();
      document.querySelectorAll('img').forEach(el => {
        const s = el.getAttribute('src');
        if (s && s.startsWith('http')) out.add(s);
      });
      document.querySelectorAll('image').forEach(el => {
        const s = el.getAttribute('xlink:href') ?? el.getAttribute('href');
        if (s && s.startsWith('http')) out.add(s);
      });
      return Array.from(out);
    });

    const MAX_BYTES = 200 * 1024;
    const map: Record<string, string> = {};
    let ok = 0, skip = 0;
    for (const url of urls) {
      try {
        const resp = await page.request.fetch(url, { headers: { Referer: 'https://www.facebook.com/' } });
        if (!resp.ok()) { skip++; continue; }
        const buf = await resp.body();
        const ct = resp.headers()['content-type'] || 'image/jpeg';
        const b64 = buf.toString('base64');
        if (buf.length > MAX_BYTES || ct.includes('gif')) {
          // Downscale oversize/animated assets in-page (OffscreenCanvas), so
          // the committed fixture stays a sane size.
          const small: string | null = await page.evaluate(async ({ b64, ct }: { b64: string; ct: string }) => {
            try {
              const bin = atob(b64);
              const arr = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
              const bmp = await createImageBitmap(new Blob([arr], { type: ct }));
              const scale = Math.min(1, 640 / bmp.width);
              const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
              const canvas = new OffscreenCanvas(w, h);
              const c2d = canvas.getContext('2d');
              if (!c2d) return null;
              c2d.drawImage(bmp, 0, 0, w, h);
              const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
              const bytes = new Uint8Array(await out.arrayBuffer());
              let s = ''; const chunk = 8192;
              for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
              return `data:image/jpeg;base64,${btoa(s)}`;
            } catch { return null; }
          }, { b64, ct });
          map[url] = small ?? `data:${ct};base64,${b64}`;
        } else {
          map[url] = `data:${ct};base64,${b64}`;
        }
        ok++;
      } catch { skip++; }
    }

    const inlined = await page.evaluate((m: Record<string, string>) => {
      let applied = 0;
      document.querySelectorAll('img').forEach(el => {
        const s = el.getAttribute('src');
        if (s && m[s]) { el.setAttribute('src', m[s]); el.removeAttribute('srcset'); applied++; }
      });
      document.querySelectorAll('image').forEach(el => {
        const attr = el.hasAttribute('xlink:href') ? 'xlink:href' : 'href';
        const s = el.getAttribute(attr);
        if (s && m[s]) { el.setAttribute(attr, m[s]); applied++; }
      });
      // Bake a poster frame onto any posterless <video> (best-effort; a
      // cross-origin frame throws and is skipped, matching live behaviour).
      let posterBaked = 0;
      for (const v of Array.from(document.querySelectorAll('video'))) {
        if (v.getAttribute('poster')) continue;
        try {
          if (v.readyState < 2 || v.videoWidth === 0) continue;
          const canvas = document.createElement('canvas');
          canvas.width = v.videoWidth; canvas.height = v.videoHeight;
          canvas.getContext('2d')?.drawImage(v, 0, 0);
          const uri = canvas.toDataURL('image/jpeg', 0.85);
          if (uri && uri !== 'data:,') { v.setAttribute('poster', uri); posterBaked++; }
        } catch { /* cross-origin — skip */ }
      }
      return { applied, posterBaked };
    }, map);
    // eslint-disable-next-line no-console
    console.log(`[fb-post-snap] fetched ${ok}/${urls.length} (skipped ${skip}), applied ${inlined.applied}, baked ${inlined.posterBaked} posters`);

    // Strip scripts / external links / video <source> so the fixture is inert
    // and offline-safe. Keep the <video poster> we just baked.
    const html = await page.evaluate(() => {
      document.querySelectorAll('script, link[rel="preload"], link[rel="prefetch"]').forEach(n => n.remove());
      document.querySelectorAll('video source').forEach(n => n.remove());
      document.querySelectorAll('video').forEach(v => v.removeAttribute('src'));
      return '<!doctype html>\n' + document.documentElement.outerHTML;
    });
    writeFileSync(FIXTURE_PATH, html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[fb-post-snap] wrote ${FIXTURE_PATH} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

    // Guard the rot: any media URL left pointing at fbcdn carries an expiring
    // signed token and will 403 within days, silently turning the fixture into
    // a blank-photo capture. Only the inert <link rel=preconnect> may remain.
    const leftovers = (html.match(/(?:src|href|xlink:href)="https:\/\/[a-z0-9-]*\.?fbcdn\.net[^"]*"/gi) ?? [])
      .filter(m => !/rel="?(pre|dns)/i.test(m));
    if (leftovers.length) {
      // eslint-disable-next-line no-console
      console.warn(`[fb-post-snap] WARNING: ${leftovers.length} un-inlined fbcdn URL(s) remain — ` +
        `these expire and the fixture will rot.`);
      leftovers.slice(0, 5).forEach(u => console.warn(`  ${u.slice(0, 110)}`));
    }
  } finally {
    await ctx.close();
  }
});
