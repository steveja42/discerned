// One-shot tool: load a real Bluesky post thread in headed Brave with the test
// profile and save BOTH:
//   - The fully-rendered HTML to tests/fixtures/sites/bsky-thread.html
//   - A side-by-side test-output/bsky-snapshot-raw.html (unmodified) for diffing
//
// cdn.bsky.app blocks CORS fetch from the page context, so images are fetched
// from Node.js via page.request.fetch() (uses the browser's cookies/headers,
// no CORS enforcement) and injected back as data URIs via page.evaluate().
//
// Run with:
//   BSKY_POST=1 PWDEBUG_HEADED=1 pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=snapshot-bsky-post

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const POST_URL = 'https://bsky.app/profile/nadyavoynich.com/post/3mnk3pdlajc2e';
const FIXTURE_PATH = resolve(__dirname, '..', '..', 'fixtures', 'sites', 'bsky-thread.html');
const RAW_PATH = resolve(__dirname, '..', '..', '..', 'test-output', 'bsky-snapshot-raw.html');

const MAX_BYTES = 200 * 1024;
const DOWNSCALE_WIDTH = 256;

test('snapshot-bsky-post', async () => {
  test.skip(!process.env.BSKY_POST, 'set BSKY_POST=1');
  test.setTimeout(180_000);

  const { ctx } = await launchWithExtension({ profile: 'test', headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    page.on('console', m => {
      const t = m.text();
      if (/inlined|skip|bsky|baked/i.test(t)) {
        // eslint-disable-next-line no-console
        console.log(`[browser] ${t}`);
      }
    });
    await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Bluesky is an SPA; wait for the post thread to actually render.
    await page.waitForSelector('[data-testid^="postThreadItem-by-"]', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4000); // settle replies + lazy images

    // Collect all remote img src URLs from the page.
    const imgSrcs: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .map(img => img.getAttribute('src') ?? '')
        .filter(src => src && !src.startsWith('data:')),
    );
    // eslint-disable-next-line no-console
    console.log(`[bsky-post] collected ${imgSrcs.length} remote img srcs`);

    // Deduplicate — same CDN URL may appear multiple times (author avatar repeats).
    const uniqueSrcs = [...new Set(imgSrcs)];

    // Fetch each image from Node.js (bypasses CORS) and build a src→dataUri map.
    const dataUriMap: Record<string, string> = {};
    for (const src of uniqueSrcs) {
      try {
        const resp = await page.request.fetch(src, { headers: { 'Referer': 'https://bsky.app/' } });
        if (!resp.ok()) {
          // eslint-disable-next-line no-console
          console.log(`[bsky-post] skip ${src}: HTTP ${resp.status()}`);
          continue;
        }
        const ct = resp.headers()['content-type'] || 'image/jpeg';
        const buf = await resp.body();
        let dataUri: string;
        if (buf.length > MAX_BYTES || ct.includes('gif')) {
          // Downscale via in-page OffscreenCanvas: inject the bytes as a blob URL.
          const b64 = buf.toString('base64');
          const downscaled: string | null = await page.evaluate(async ({ b64, ct, w }: { b64: string, ct: string, w: number }) => {
            try {
              const binary = atob(b64);
              const arr = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
              const blob = new Blob([arr], { type: ct });
              const bmp = await createImageBitmap(blob);
              const scale = Math.min(1, w / bmp.width);
              const dw = Math.round(bmp.width * scale);
              const dh = Math.round(bmp.height * scale);
              const canvas = new OffscreenCanvas(dw, dh);
              const ctx2d = canvas.getContext('2d');
              if (!ctx2d) return null;
              ctx2d.drawImage(bmp, 0, 0, dw, dh);
              const out = await canvas.convertToBlob({ type: 'image/png' });
              const outBuf = await out.arrayBuffer();
              const bytes = new Uint8Array(outBuf);
              let bin = '';
              const chunk = 8192;
              for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
              return `data:image/png;base64,${btoa(bin)}`;
            } catch { return null; }
          }, { b64, ct, w: DOWNSCALE_WIDTH });
          dataUri = downscaled ?? `data:${ct};base64,${b64}`;
        } else {
          dataUri = `data:${ct};base64,${buf.toString('base64')}`;
        }
        dataUriMap[src] = dataUri;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[bsky-post] skip ${src}: ${e}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[bsky-post] fetched ${Object.keys(dataUriMap).length}/${uniqueSrcs.length} unique images`);

    // Inject data URIs back into the page DOM.
    const inlinedCount: number = await page.evaluate((map: Record<string, string>) => {
      let ok = 0;
      for (const img of Array.from(document.querySelectorAll('img'))) {
        const src = img.getAttribute('src');
        if (src && map[src]) { img.setAttribute('src', map[src]); ok++; }
      }
      return ok;
    }, dataUriMap);
    // eslint-disable-next-line no-console
    console.log(`[bsky-post] inlined ${inlinedCount} img elements`);

    // For every <video> element, bake a poster frame via Node.js fetch + in-page canvas.
    const videoSrcs: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('video'))
        .map(v => v.querySelector('source')?.getAttribute('src') ?? v.getAttribute('src') ?? '')
        .filter(Boolean),
    );
    let posterCount = 0;
    for (const src of videoSrcs) {
      try {
        const resp = await page.request.fetch(src, { headers: { 'Referer': 'https://bsky.app/' } });
        if (!resp.ok()) continue;
        const buf = await resp.body();
        const b64 = buf.toString('base64');
        const ct = resp.headers()['content-type'] || 'video/mp4';
        const posterUri: string | null = await page.evaluate(async ({ b64, ct, src }: { b64: string, ct: string, src: string }) => {
          try {
            const binary = atob(b64);
            const arr = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
            const blob = new Blob([arr], { type: ct });
            const blobUrl = URL.createObjectURL(blob);
            const tmp = document.createElement('video');
            tmp.crossOrigin = 'anonymous';
            tmp.muted = true;
            tmp.src = blobUrl;
            await new Promise<void>((res, rej) => {
              tmp.addEventListener('loadeddata', () => res(), { once: true });
              tmp.addEventListener('error', () => rej(new Error('video load error')), { once: true });
              setTimeout(() => rej(new Error('video load timeout')), 10_000);
            });
            const target = Math.min(1.0, (tmp.duration || 2) / 4);
            await new Promise<void>((res, rej) => {
              tmp.addEventListener('seeked', () => res(), { once: true });
              tmp.currentTime = target;
              setTimeout(() => rej(new Error('seek timeout')), 5000);
            });
            const w = tmp.videoWidth, h = tmp.videoHeight;
            if (!w || !h) { URL.revokeObjectURL(blobUrl); return null; }
            const canvas = new OffscreenCanvas(w, h);
            const ctx2d = canvas.getContext('2d');
            if (!ctx2d) { URL.revokeObjectURL(blobUrl); return null; }
            ctx2d.drawImage(tmp, 0, 0, w, h);
            const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
            const outBuf = await out.arrayBuffer();
            const bytes = new Uint8Array(outBuf);
            let bin = '';
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
            URL.revokeObjectURL(blobUrl);
            return `data:image/jpeg;base64,${btoa(bin)}`;
          } catch (e) {
            console.log(`video poster skip ${src}: ${e}`);
            return null;
          }
        }, { b64, ct, src });
        if (posterUri) {
          // Set poster on the video element matching this src.
          await page.evaluate(({ src, poster }: { src: string, poster: string }) => {
            for (const v of Array.from(document.querySelectorAll('video'))) {
              const vsrc = v.querySelector('source')?.getAttribute('src') ?? v.getAttribute('src');
              if (vsrc === src) v.setAttribute('poster', poster);
            }
          }, { src, poster: posterUri });
          posterCount++;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[bsky-post] video poster skip: ${e}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[bsky-post] baked ${posterCount} video posters`);

    // Strip <script> / external <link> tags so the fixture is self-contained.
    await page.evaluate(() => {
      document.querySelectorAll('script').forEach(s => s.remove());
      document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"]').forEach(l => l.remove());
      document.querySelectorAll('video source').forEach(s => s.remove());
    });

    const html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
    writeFileSync(FIXTURE_PATH, html, 'utf8');
    writeFileSync(RAW_PATH, html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[bsky-post] wrote ${FIXTURE_PATH} (${(html.length / 1024).toFixed(0)} KB)`);
  } finally {
    await ctx.close();
  }
});
