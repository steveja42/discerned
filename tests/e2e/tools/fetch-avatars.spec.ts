// One-shot tool: load the original primal + bsky avatar URLs in real headed
// Chromium with the test profile, dump each successfully-loaded image as a
// base64 data URI to test-output/avatar-bytes.json so the fixture HTML can
// be rewritten with real inlined avatars.
//
// Run with:
//   AVATARS=1 PWDEBUG_HEADED=1 pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=fetch-avatars

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const URLS = [
  // primal
  'https://r2.primal.net/cache/a/9a/74/avatar.png',
  'https://r2.primal.net/cache/f/d7/51/vitor.jpg',
  'https://r2.primal.net/cache/5/d8/41/akashi.jpg',
  'https://r2.primal.net/cache/amir.png',
  'https://r2.primal.net/cache/8/6c/b8/trbouma.png',
  'https://r2.primal.net/cache/3/90/24/jostric.jpg',
  'https://r2.primal.net/cache/4/d2/d2/fade2.png',
  // bsky — synthetic DIDs, will likely 404. Included so we see the failure.
  'https://cdn.bsky.app/img/avatar/plain/did:plc:test/avatar.jpg@jpeg',
  'https://cdn.bsky.app/img/avatar/plain/did:plc:replier1/avatar.jpg@jpeg',
  'https://cdn.bsky.app/img/avatar/plain/did:plc:replier2/avatar.jpg@jpeg',
  'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:test/post-image.jpg@jpeg',
];

test('fetch-avatars', async () => {
  test.skip(!process.env.AVATARS, 'set AVATARS=1');
  test.setTimeout(180_000);

  const { ctx } = await launchWithExtension({ profile: 'test', headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    // Land on a real primal page first so cookies/origin context are warm.
    await page.goto('https://primal.net/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(2000);

    const results: Record<string, { ok: boolean; status: number; bytes: number; dataUri?: string; error?: string }> = {};

    for (const url of URLS) {
      try {
        const res = await page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'omit', cache: 'no-cache' });
          if (!r.ok) return { ok: false, status: r.status, bytes: 0 };
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          // base64-encode in chunks (large strings choke btoa otherwise)
          let bin = '';
          const chunk = 8192;
          for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          const b64 = btoa(bin);
          const ct = r.headers.get('content-type') ?? 'image/jpeg';
          return { ok: true, status: r.status, bytes: bytes.length, dataUri: `data:${ct};base64,${b64}` };
        }, url);
        results[url] = res as typeof results[string];
        // eslint-disable-next-line no-console
        console.log(`${url}  -> ${res.status} (${res.bytes} bytes)`);
      } catch (err) {
        results[url] = { ok: false, status: 0, bytes: 0, error: String(err) };
        // eslint-disable-next-line no-console
        console.log(`${url}  -> ERROR ${err}`);
      }
    }

    const outPath = resolve(__dirname, '..', '..', '..', 'test-output', 'avatar-bytes.json');
    writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`\nwrote ${outPath}`);
  } finally {
    await ctx.close();
  }
});
