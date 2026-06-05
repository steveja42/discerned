// One-shot tool: load a real primal note in headed Brave with the test
// profile and save BOTH:
//   - The fully-rendered HTML to tests/fixtures/sites/primal-thread.html
//   - A side-by-side test-output/primal-snapshot-raw.html (unmodified) for diffing
//
// All <img> elements with src URLs are rewritten to inline data URIs by
// fetching their bytes through the real Brave session (so primal CDN cookies
// / headers apply) and base64-encoding. This produces a self-contained
// fixture with REAL avatars baked in.
//
// Run with:
//   PRIMAL_NOTE=1 PWDEBUG_HEADED=1 pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=snapshot-primal-note

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const NOTE_URL = 'https://primal.net/e/nevent1qqs8plraset6jd4q77rq3k8xk4ayrrusg59f38dp93qtj629w70s8rcuj95zp';
const FIXTURE_PATH = resolve(__dirname, '..', '..', 'fixtures', 'sites', 'primal-thread.html');
const RAW_PATH = resolve(__dirname, '..', '..', '..', 'test-output', 'primal-snapshot-raw.html');

test('snapshot-primal-note', async () => {
  test.skip(!process.env.PRIMAL_NOTE, 'set PRIMAL_NOTE=1');
  test.setTimeout(180_000);

  const { ctx } = await launchWithExtension({ profile: 'test', headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    page.on('console', m => {
      const t = m.text();
      if (/inlined|skip|primal/i.test(t)) {
        // eslint-disable-next-line no-console
        console.log(`[browser] ${t}`);
      }
    });
    await page.goto(NOTE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Primal is an SPA; wait for the post content + replies to actually render.
    await page.waitForSelector('[class*="_primaryNote_"], [class*="primaryNote"]', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(5000); // settle replies + zaps

    // Step 1: inline every img.src as a data URI by fetching through the page.
    // Using fetch() inside page.evaluate carries the page's origin/cookies,
    // which avoids CDN cache rejections curl gets. Large images (>200 KB) and
    // GIFs are re-encoded as 256px-wide PNGs via canvas to keep the fixture
    // file size sane — for a static pixel baseline, animated GIF reactions
    // and full-res photos provide no signal beyond their thumbnail.
    const inlinedCount = await page.evaluate(async () => {
      const MAX_BYTES = 200 * 1024;
      const DOWNSCALE_WIDTH = 256;
      const imgs = Array.from(document.querySelectorAll('img'));
      let ok = 0, skip = 0;

      async function downscale(blob: Blob): Promise<string | null> {
        try {
          const bmp = await createImageBitmap(blob);
          const scale = Math.min(1, DOWNSCALE_WIDTH / bmp.width);
          const w = Math.round(bmp.width * scale);
          const h = Math.round(bmp.height * scale);
          const canvas = new OffscreenCanvas(w, h);
          const ctx2d = canvas.getContext('2d');
          if (!ctx2d) return null;
          ctx2d.drawImage(bmp, 0, 0, w, h);
          const out = await canvas.convertToBlob({ type: 'image/png' });
          const buf = await out.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          const chunk = 8192;
          for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
          return `data:image/png;base64,${btoa(bin)}`;
        } catch { return null; }
      }

      for (const img of imgs) {
        const src = img.getAttribute('src');
        if (!src || src.startsWith('data:')) { skip++; continue; }
        try {
          const r = await fetch(src, { credentials: 'omit', cache: 'no-cache' });
          if (!r.ok) { console.log(`skip ${src}: HTTP ${r.status}`); skip++; continue; }
          const blob = await r.blob();
          const ct = r.headers.get('content-type') || 'image/jpeg';
          let dataUri: string | null = null;

          if (blob.size > MAX_BYTES || ct.includes('gif')) {
            dataUri = await downscale(blob);
          }
          if (!dataUri) {
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
            dataUri = `data:${ct};base64,${btoa(bin)}`;
          }
          img.setAttribute('src', dataUri);
          ok++;
        } catch (e) {
          console.log(`skip ${src}: ${e}`);
          skip++;
        }
      }
      console.log(`inlined ${ok} imgs (skipped ${skip})`);
      return ok;
    });
    // eslint-disable-next-line no-console
    console.log(`[primal-note] inlined ${inlinedCount} avatars/images`);

    // Step 1.5: for every <video> element, fetch the video bytes via CORS,
    // load them into a same-origin <video> (via blob: URL), seek to the first
    // frame, and bake the frame into the original element's `poster=` attr.
    // The blob: URL keeps the canvas untainted (the live video's cross-origin
    // src would have tainted it). Capture pipeline reads poster= when
    // substituting <video> → image, so without this the video drops out.
    const posterCount = await page.evaluate(async () => {
      const vids = Array.from(document.querySelectorAll('video'));
      let ok = 0;
      for (const v of vids) {
        const source = v.querySelector('source')?.getAttribute('src') || v.getAttribute('src');
        if (!source) continue;
        try {
          const r = await fetch(source, { credentials: 'omit', cache: 'no-cache' });
          if (!r.ok) { console.log(`video fetch ${source} -> HTTP ${r.status}`); continue; }
          const blob = await r.blob();
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
          // Seek to a representative frame (1s in, or partway if shorter).
          const target = Math.min(1.0, (tmp.duration || 2) / 4);
          await new Promise<void>((res, rej) => {
            tmp.addEventListener('seeked', () => res(), { once: true });
            tmp.currentTime = target;
            setTimeout(() => rej(new Error('seek timeout')), 5000);
          });
          const w = tmp.videoWidth, h = tmp.videoHeight;
          if (!w || !h) { URL.revokeObjectURL(blobUrl); continue; }
          const canvas = new OffscreenCanvas(w, h);
          const ctx2d = canvas.getContext('2d');
          if (!ctx2d) { URL.revokeObjectURL(blobUrl); continue; }
          ctx2d.drawImage(tmp, 0, 0, w, h);
          const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
          const buf = await out.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          const chunk = 8192;
          for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
          v.setAttribute('poster', `data:image/jpeg;base64,${btoa(bin)}`);
          URL.revokeObjectURL(blobUrl);
          ok++;
        } catch (e) {
          console.log(`video poster skip: ${e}`);
        }
      }
      console.log(`baked ${ok} video posters`);
      return ok;
    });
    // eslint-disable-next-line no-console
    console.log(`[primal-note] baked ${posterCount} video posters`);

    // Strip <script> / external <link> tags so the fixture is self-contained
    // when served from 127.0.0.1 (no remote JS, no network attempts at load).
    // Also strip <source> elements inside <video> so the offline fixture
    // doesn't try to load the original video URL — we keep poster only.
    await page.evaluate(() => {
      document.querySelectorAll('script').forEach(s => s.remove());
      document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"]').forEach(l => l.remove());
      document.querySelectorAll('video source').forEach(s => s.remove());
    });

    const html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
    writeFileSync(FIXTURE_PATH, html, 'utf8');
    writeFileSync(RAW_PATH, html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[primal-note] wrote ${FIXTURE_PATH} (${(html.length / 1024).toFixed(0)} KB)`);
  } finally {
    await ctx.close();
  }
});
