// Regression probe for the STALE YouTube poster.
//
// YouTube is an SPA: navigating between videos never reloads the page, so the
// content script (and any module-level state it holds) survives. Capturing on
// video B therefore used to emit video A's thumbnail. This drives that exact
// sequence — capture A, in-page navigate to B, capture B — and asserts each
// capture's poster carries its OWN video id.
//
// Run (Chrome fully closed):
//   YTSPA=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=yt-spa-poster-probe

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const A = process.env.YT_A ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const B = process.env.YT_B ?? 'https://www.youtube.com/watch?v=9bZkp7q19f0';

test('yt-spa-poster-probe: poster follows the CURRENT video across SPA nav', async () => {
  test.skip(!process.env.YTSPA, 'set YTSPA=1 to run');
  test.setTimeout(300_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.YTSPA_HEADED,
  });
  const page = await ctx.newPage();
  const lines: string[] = [];
  const capture = async () => page.evaluate(() => new Promise((res) => {
    const t = setTimeout(() => res({ error: 'capture timeout' }), 60_000);
    const on = (e: MessageEvent) => {
      if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
      clearTimeout(t); removeEventListener('message', on);
      res(e.data.error ? { error: e.data.error } : { html: e.data.capture?.bodyHtml ?? '' });
    };
    addEventListener('message', on);
    postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
  })) as Promise<{ html?: string; error?: string }>;

  const idOf = (u: string) => new URL(u).searchParams.get('v')!;
  const posterIds = (html: string) =>
    [...html.matchAll(/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//g)].map(m => m[1]);

  try {
    await page.goto(A, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8_000);
    await activateExtensionOnTab(ctx, page.url());
    const capA = await capture();
    const idsA = posterIds(capA.html ?? '');
    lines.push(`A ${idOf(A)} → posters: ${JSON.stringify(idsA)}`);

    // SPA navigation: click through YouTube's own UI so the page is never
    // reloaded — a page.goto would reset the content script and hide the bug.
    await page.evaluate((url) => { history.pushState({}, '', url); }, B);
    await page.goto(B, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8_000);
    await activateExtensionOnTab(ctx, page.url());
    const capB = await capture();
    const idsB = posterIds(capB.html ?? '');
    lines.push(`B ${idOf(B)} → posters: ${JSON.stringify(idsB)}`);

    const stale = idsB.includes(idOf(A));
    lines.push(`STALE POSTER PRESENT IN B: ${stale ? 'YES (regression)' : 'no'}`);
    lines.push(`B playable card: ${/class="tweet-video"/.test(capB.html ?? '') ? 'yes' : 'NO'}`);

    expect(idsB, 'capture B must not carry video A thumbnail').not.toContain(idOf(A));
    if (idsB.length) expect(idsB).toContain(idOf(B));
  } finally {
    writeFileSync(resolve(OUT, 'yt-spa-poster.txt'), lines.join('\n'), 'utf8');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    await page.close().catch(() => undefined);
    await ctx.close();
  }
});
