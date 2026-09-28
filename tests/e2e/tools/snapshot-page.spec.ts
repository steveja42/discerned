// One-shot tool: snapshot ANY live page into a self-contained fixture at
// tests/fixtures/sites/<name>.html, for a *-fixture-visual pixel baseline.
// Uses the warm Profile 3, where walled forums load, and removes every network
// dependency so the baseline cannot drift:
//   - <img> bytes are fetched Node-side (page.request: browser cookies, no CORS)
//     and inlined as data URIs; big ones are downscaled; srcset/<source> dropped
//   - stylesheets are inlined as <style>
//   - <script>, <iframe>, <noscript> are removed (an embed would fetch live)
// It never activates the extension, so the snapshot carries no dx-* markers.
//
// Run from the repo root with Chrome fully closed:
//   SNAPPAGE=1 SNAPPAGE_URL=<url> SNAPPAGE_NAME=<fixture-name> [SNAPPAGE_WAIT=12] \
//     pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=snapshot-page

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const FIXTURE_DIR = resolve(__dirname, '..', '..', 'fixtures', 'sites');
const MAX_BYTES = 150 * 1024;
const DOWNSCALE_WIDTH = 800;

test('snapshot-page', async () => {
  test.skip(!process.env.SNAPPAGE, 'set SNAPPAGE=1');
  const url = process.env.SNAPPAGE_URL;
  const name = process.env.SNAPPAGE_NAME;
  if (!url || !name) throw new Error('set SNAPPAGE_URL and SNAPPAGE_NAME');
  test.setTimeout(300_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true,
    headed: process.env.SNAPPAGE_HEADED !== '0',
  });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(Number(process.env.SNAPPAGE_WAIT ?? 12) * 1000);

    const fetchBody = async (u: string) => {
      try {
        const r = await page.request.fetch(u, { headers: { Referer: url } });
        return r.ok() ? { body: await r.body(), type: (r.headers()['content-type'] ?? '').split(';')[0] } : null;
      } catch { return null; }
    };

    // Images: key by the URL the browser actually chose (currentSrc covers srcset).
    const imgUrls: string[] = await page.evaluate(() =>
      Array.from(document.images).map(img => img.currentSrc || img.src));
    const dataUris: Record<string, string> = {};
    // Same-origin fallback: some forums serve attachments only to a page request.
    const fetchInPage = (u: string) => page.evaluate(async (src) => {
      try {
        const r = await fetch(src, { credentials: 'include' });
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { b64: btoa(bin), type: (r.headers.get('content-type') ?? '').split(';')[0] };
      } catch { return null; }
    }, u).then(got => got && { body: Buffer.from(got.b64, 'base64'), type: got.type });

    for (const u of new Set(imgUrls.filter(s => /^https?:/.test(s)))) {
      const got = await fetchBody(u) ?? await fetchInPage(u);
      if (!got) continue;
      const type = got.type.startsWith('image/') ? got.type : 'image/png';
      const raw = `data:${type};base64,${got.body.toString('base64')}`;
      dataUris[u] = got.body.length <= MAX_BYTES || type === 'image/svg+xml' ? raw
        : await page.evaluate(async ({ raw, w }) => {
          try {
            const bmp = await createImageBitmap(await (await fetch(raw)).blob());
            const scale = Math.min(1, w / bmp.width);
            const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
            canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
            let bin = '';
            for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return `data:image/jpeg;base64,${btoa(bin)}`;
          } catch { return raw; }
        }, { raw, w: DOWNSCALE_WIDTH });
    }

    const cssUrls: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).map(l => l.href));
    const css: Record<string, string> = {};
    for (const u of new Set(cssUrls)) {
      const got = await fetchBody(u);
      if (got) css[u] = got.body.toString('utf8');
    }

    const html: string = await page.evaluate(({ dataUris, css }) => {
      for (const img of Array.from(document.images)) {
        const uri = dataUris[img.currentSrc || img.src];
        if (uri) img.setAttribute('src', uri);
        for (const a of ['srcset', 'sizes', 'loading', 'data-src', 'data-srcset']) img.removeAttribute(a);
      }
      document.querySelectorAll('picture > source').forEach(s => s.remove());
      document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]').forEach(l => {
        const style = document.createElement('style');
        style.textContent = css[l.href] ?? '';
        l.replaceWith(style);
      });
      document.querySelectorAll('script, iframe, noscript, link[rel="preload"], link[rel="modulepreload"]')
        .forEach(el => el.remove());
      return '<!doctype html>\n' + document.documentElement.outerHTML;
    }, { dataUris, css });

    const outPath = resolve(FIXTURE_DIR, `${name}.html`);
    writeFileSync(outPath, html, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[snapshot-page] ${Object.keys(dataUris).length} images, ${Object.keys(css).length} stylesheets → ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);
  } finally {
    await ctx.close();
  }
});
