// Capture a LIVE Instagram reel with the current build and save the real
// bodyHtml + a render of it. Reconstructed markup repeatedly behaved
// differently from the live clip, so the avatar/username layout has to be
// judged against what the pipeline actually produces.
//
// Run (Chrome must be CLOSED — uses the warm profile):
//   IGLIVE=1 [IG_URL=...] pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=ig-reel-live-capture

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const URL_ = process.env.IG_URL ?? 'https://www.instagram.com/reels/DdIpkEaiXt2/?hl=en';

test('capture a live reel and render its header', async () => {
  test.skip(!process.env.IGLIVE, 'set IGLIVE=1 to run');
  test.setTimeout(300_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome',
    preinstalledExtension: true,
    headed: !!process.env.IG_HEADED,
  });
  const page = await ctx.newPage();
  page.on('console', msg => {
    const t = msg.text();
    if (/inlineImage|Discerned/i.test(t)) console.log('[PAGE] ' + t);
  });
  try {
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(Number(process.env.IG_WAIT ?? 9_000));
    await activateExtensionOnTab(ctx, URL_);

    const cap = await page.evaluate(async () => {
      return await new Promise<Record<string, unknown> | null>(res => {
        const to = setTimeout(() => res(null), 45_000);
        window.addEventListener('message', function h(e: MessageEvent) {
          if (e.data?.type === '__DISCERNED_TEST_CAPTURE_RESULT') {
            clearTimeout(to); window.removeEventListener('message', h);
            res(e.data.capture ?? null);
          }
        });
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, '*');
      });
    });

    expect(cap, 'capture returned').toBeTruthy();
    const body = String((cap as Record<string, unknown>).bodyHtml ?? '');
    writeFileSync(resolve(OUT, 'ig-reel-live-body.html'), body, 'utf8');
    const markers = ['dx-reel', 'dx-reel-caption', 'dx-header', 'dx-avatar', 'tweet-video'];
    console.log('IGLIVE markers ' + JSON.stringify(
      Object.fromEntries(markers.map(m => [m, body.split(m).length - 1]))));
    console.log('IGLIVE bodyLen ' + body.length);
    console.log('IGLIVE thumbnailUrl ' + String((cap as Record<string, unknown>).thumbnailUrl));
    const avatarMatch = body.match(/class="dx-avatar"[^>]*src="([^"]*)"/)
      ?? body.match(/src="([^"]*)"[^>]*class="dx-avatar"/);
    const avatarSrc = avatarMatch?.[1] ?? '(no dx-avatar img found)';
    console.log('IGLIVE avatarSrcKind ' + (avatarSrc.startsWith('data:') ? 'INLINED' : avatarSrc.startsWith('http') ? 'HOTLINKED' : 'MISSING'));
  } finally {
    await ctx.close();
  }
});
