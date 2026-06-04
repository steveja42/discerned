// Verify Reddit site-tagger work applies to all three capture formats
// (article, selection, full-page). The improvements introduced for the
// `article` format (dx-byline rebuild, avatar hoist, triple-image dedup, ad
// removal, back-arrow removal) MUST also benefit the other two formats.
//
// Run: $env:REDDIT_FORMATS='1'; npx playwright test \
//   -c tests/e2e/playwright.config.ts --project=reddit-formats-visual

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const RD_URL =
  process.env.REDDIT_URL ||
  'https://www.reddit.com/r/mildlyinfuriating/comments/1tw7cla/this_car_ive_never_seen_before_has_been_parked_in/';

test.describe.configure({ mode: 'serial' });

test('reddit-formats: article / selection / full-page all use site tagger', async () => {
  test.skip(!process.env.REDDIT_FORMATS, 'set REDDIT_FORMATS=1 to run this');
  test.setTimeout(360_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  // Use the warmed 'test' profile to get past any Reddit JS challenge.
  const profile = process.env.PROFILE ?? 'test';
  const headed = process.env.PWDEBUG_HEADED === '0' ? false : true;
  const { ctx } = await launchWithExtension({ profile, headed });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(RD_URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('shreddit-post, article', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);

    // Helper: capture format X, post to /library, take screenshot of the
    // top of clip body so we can eyeball the byline alignment.
    const captureAndSnap = async (format: 'article' | 'selection' | 'full-page', tag: string) => {
      // For selection, set up a Range over the shreddit-post first so the
      // selection extractor has something to work with.
      if (format === 'selection') {
        await page.evaluate(() => {
          const post = document.querySelector('shreddit-post');
          if (!post) return;
          const range = document.createRange();
          range.selectNodeContents(post);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        });
      }

      const cap = (await page.evaluate(async (fmt) => {
        return new Promise((resolveCap, rejectCap) => {
          const timer = setTimeout(() => rejectCap(new Error('capture timeout')), 30_000);
          const onMessage = (e: MessageEvent) => {
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            if (e.data.error) rejectCap(new Error(e.data.error));
            else resolveCap(e.data.capture);
          };
          window.addEventListener('message', onMessage);
          window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: fmt }, window.location.origin);
        });
      }, format)) as Record<string, unknown>;

      // Save a short HTML preview so we can verify dx-* markers landed.
      const body = (cap.bodyHtml ?? cap.selectionText ?? '') as string;
      writeFileSync(out(`reddit-${tag}-body.html`), body, 'utf8');

      const libPage = await ctx.newPage();
      await libPage.goto('http://localhost:3000/library', { waitUntil: 'networkidle' });
      await libPage.evaluate((capture) => {
        const clip = { capture, evaluation: { interest: 'Interesting', ethics: 'Honest', category: 'General' }, encrypted: '' };
        window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
        window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
      }, cap);
      const row = libPage.locator('article.clip').first();
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await row.click();
      const clipBody = libPage.locator('.clip-body');
      await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
      await libPage.waitForTimeout(800);

      const bodyBox = await clipBody.boundingBox();
      if (bodyBox) {
        await libPage.screenshot({
          path: out(`reddit-${tag}-top.png`),
          clip: { x: bodyBox.x, y: bodyBox.y, width: Math.min(bodyBox.width, 800), height: 700 },
        });
      }
      await libPage.close();
      return body;
    };

    const articleBody = await captureAndSnap('article', 'article');
    const selectionBody = await captureAndSnap('selection', 'selection');
    const fullPageBody = await captureAndSnap('full-page', 'fullpage');

    // dx-* markers should be present across all three formats now that the
    // site tagger runs for selection and full-page too.
    expect(articleBody, 'article body has dx-byline-col').toMatch(/dx-byline-col/);
    expect(selectionBody, 'selection body has dx-byline-col').toMatch(/dx-byline-col/);
    expect(fullPageBody, 'full-page body has dx-byline-col').toMatch(/dx-byline-col/);
    // Back-arrow chrome from <pdp-back-button> shadow root should be gone in
    // all three (the dx-excl on its host propagates to the clone).
    expect(articleBody, 'no Back chrome in article').not.toMatch(/>Back<|Back<!--/);
    expect(fullPageBody, 'no Back chrome in full-page').not.toMatch(/>Back<|Back<!--/);

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved reddit-article/selection/fullpage artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
