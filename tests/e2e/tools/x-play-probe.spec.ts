// Does a reply's video actually PLAY IN PLACE in the rendered clip?
//
// Every tweet card used to be built with the FOCUSED tweet's URL, so a reply's
// play card carried the wrong /status/<id>; video-embed.ts resolves the embed
// from that id, so clicking it embedded the wrong post (or nothing). This
// clicks the play card in a real /clips render and reports the iframe that
// results, so the id in the embed can be compared against the reply that owns
// the video.
//
// Run: XPLAY=1 [XPLAY_URL=<url>] pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=x-play-probe

import { test } from '@playwright/test';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const URL = process.env.XPLAY_URL ?? 'https://x.com/CIA/status/2055074954375254084';

test('x-play-probe', async () => {
  test.skip(!process.env.XPLAY, 'set XPLAY=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);
    await activateExtensionOnTab(ctx, URL);

    const cap = (await page.evaluate(async () => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('capture timeout')), 60_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(timer); window.removeEventListener('message', on);
        if (e.data.error) rej(new Error(e.data.error)); else res(e.data.capture);
      };
      window.addEventListener('message', on);
      window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
    }))) as Record<string, unknown>;

    const lib = await ctx.newPage();
    await lib.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await lib.evaluate((c) => {
      const clip = { capture: c, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, cap);
    await lib.locator('article.clip').first().waitFor({ state: 'visible', timeout: 15_000 });
    await lib.locator('article.clip').first().click();
    const body = lib.locator('.clip-body');
    await body.waitFor({ state: 'visible', timeout: 15_000 });
    await lib.waitForTimeout(1000);

    const cards = body.locator('a.tweet-video');
    const n = await cards.count();
    // eslint-disable-next-line no-console
    console.log(`[play] tweet-video cards: ${n}`);
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line no-console
      console.log(`[play]   card[${i}] href=${await cards.nth(i).getAttribute('href')}`);
    }
    if (n === 0) { console.log('[play] no video on this thread'); return; }

    await cards.first().scrollIntoViewIfNeeded();
    await cards.first().click();
    await lib.waitForTimeout(3000);

    const frames = await body.evaluate((root: Element) =>
      Array.from(root.querySelectorAll('iframe')).map(f => f.getAttribute('src') ?? ''));
    // eslint-disable-next-line no-console
    console.log(`[play] iframes after click: ${frames.length}`);
    frames.forEach((f, i) => console.log(`[play]   iframe[${i}] ${f}`));
    const posterHidden = await body.evaluate((root: Element) => {
      const a = root.querySelector('a.tweet-video') as HTMLElement | null;
      return a ? getComputedStyle(a).display : '(gone)';
    });
    // eslint-disable-next-line no-console
    console.log(`[play] poster card display after click: ${posterHidden}`);
  } finally {
    await ctx.close();
  }
});
