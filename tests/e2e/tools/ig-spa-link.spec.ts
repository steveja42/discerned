// Regression: capturing reel B after viewing reel A must embed B's video.
//
// Instagram is an SPA and does NOT rewrite <link rel="canonical"> / og:url on a
// client-side navigation, so those tags still describe the PREVIOUS reel. The
// tagger used to prefer the canonical tag, which made a fresh clip play the
// previously viewed reel's video. It now derives the permalink from
// window.location, which is always current.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const A = process.env.IG_A ?? 'Dc1goBzv1Rm';
const B = process.env.IG_B ?? 'DcPdzGSypDF';

test('ig-spa-link: clip embeds the CURRENT reel, not the previously viewed one', async () => {
  test.skip(!process.env.IGSPA, 'set IGSPA=1 to run');
  test.setTimeout(300_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.IGSPA_HEADED,
  });
  const page = await ctx.newPage();
  const lines: string[] = [];
  const capture = () => page.evaluate(() => new Promise((res) => {
    const t = setTimeout(() => res({ error: 'capture timeout' }), 60_000);
    const on = (e: MessageEvent) => {
      if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
      clearTimeout(t); removeEventListener('message', on);
      res(e.data.error ? { error: e.data.error } : { html: e.data.capture?.bodyHtml ?? '' });
    };
    addEventListener('message', on);
    postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
  })) as Promise<{ html?: string; error?: string }>;

  try {
    // View reel A first so the stale head tags describe it.
    await page.goto(`https://www.instagram.com/reels/${A}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8_000);
    await activateExtensionOnTab(ctx, page.url());
    await capture();

    // Move to reel B WITHOUT a reload. A page.goto would refetch the document
    // and refresh the head tags, hiding the very staleness under test — the
    // bug only appears on a client-side navigation, which is how a person
    // actually scrolls from one reel to the next.
    await page.evaluate((code) => history.pushState({}, '', `/reels/${code}/`), B);
    await page.waitForTimeout(8_000);
    await activateExtensionOnTab(ctx, page.url());
    const capB = await capture();
    const html = capB.html ?? '';

    const canonicalInHead = await page.evaluate(() =>
      document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null);
    const hrefs = [...html.matchAll(/class="tweet-video"[^>]*href="([^"]+)"/g)].map(m => m[1]);
    lines.push(`head canonical while on B: ${canonicalInHead}`);
    lines.push(`play-card hrefs in clip B: ${JSON.stringify(hrefs)}`);
    lines.push(`contains A (${A})? ${hrefs.some(h => h.includes(A))}`);
    lines.push(`contains B (${B})? ${hrefs.some(h => h.includes(B))}`);

    expect(hrefs.join(' '), 'clip B must not link reel A').not.toContain(A);
    expect(hrefs.join(' '), 'clip B must link reel B').toContain(B);
  } finally {
    writeFileSync(resolve(OUT, 'ig-spa-link.txt'), lines.join('\n'), 'utf8');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    await page.close().catch(() => undefined);
    await ctx.close();
  }
});
