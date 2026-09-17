// Live visual + assertion harness for CONVERSATION capture on x.com: the
// focused tweet plus its replies, rather than the focused tweet alone.
//
// What it guards. extractTweet used to build exactly one card from the first
// <article> on the page, so a status page's replies — the part that carries
// the argument, the correction, the context — were silently dropped. The
// reply set is now collected by collectTweetReplyArticles(), whose rules come
// from tests/e2e/tools/x-thread-probe.spec.ts measuring the live DOM:
// sibling <article>s in one derived <ul> container, the focused tweet
// identified by its own status link matching the address bar, and each
// container child contributing its OUTERMOST article (the focused tweet's
// child held 2 — the inner one being its quoted tweet).
//
// This is a LIVE spec and x.com is logged-out here, so the assertions are
// deliberately shape-based (a thread wrapper, >= 1 reply card, replies by a
// DIFFERENT handle than the focused tweet) rather than pinned to any specific
// reply text, which changes by the hour. Writes the standard three images.
//
// Run: XTHREAD_VIS=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=x-thread-visual

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';
import { screenshotClipBody, screenshotSourcePage } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';

const X_URL = process.env.XTHREAD_URL ?? 'https://x.com/CIA/status/2055074954375254084';

test.describe.configure({ mode: 'serial' });

test('x-thread-visual', async () => {
  test.skip(!process.env.XTHREAD_VIS, 'set XTHREAD_VIS=1 to run');
  test.setTimeout(240_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Discerned')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, msg.text());
      }
    });
    await page.goto(X_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // x.com hydrates client-side and loads replies lazily.
    await page.waitForTimeout(6_000);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(2_000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1_500);
    await screenshotSourcePage(page, out('x-thread-source.png'));

    await activateExtensionOnTab(ctx, X_URL);

    const cap = (await page.evaluate(async () => {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('capture timeout')), 60_000);
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (e.data.error) rej(new Error(e.data.error));
          else res(e.data.capture);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    const bodyHtml = (cap.bodyHtml as string) ?? '';
    const bodyText = (cap.bodyText as string) ?? '';
    writeFileSync(
      out('x-thread-capture.json'),
      JSON.stringify({ ...cap, bodyHtml: bodyHtml.slice(0, 200_000) }, null, 2),
      'utf8',
    );

    const cards = (bodyHtml.match(/class="tweet-card\b/g) ?? []).length;
    const replies = (bodyHtml.match(/class="tweet-reply"/g) ?? []).length;
    // eslint-disable-next-line no-console
    console.log(`[x-thread] cards=${cards} replies=${replies} bodyHtml=${bodyHtml.length} bodyText=${bodyText.length}`);

    // The focused tweet must still be there and still lead the clip.
    expect(bodyHtml).toMatch(/class="tweet-card\b/);
    expect(bodyHtml.indexOf('tweet-card')).toBeLessThan(bodyHtml.indexOf('tweet-reply') === -1 ? Infinity : bodyHtml.indexOf('tweet-reply'));

    // The conversation itself: a thread wrapper and at least one reply card.
    expect(bodyHtml, 'replies should be captured on a conversation page').toMatch(/class="tweet-thread"/);
    expect(replies, 'at least one reply card').toBeGreaterThanOrEqual(1);
    expect(cards, 'a card for the focused tweet plus one per reply').toBeGreaterThan(1);

    // A reply must be somebody ELSE's post — this is what proves the cards are
    // genuine replies rather than the focused tweet rendered N times, which is
    // the failure mode a plain card count cannot distinguish.
    const handles = Array.from(bodyHtml.matchAll(/class="tweet-handle">@([A-Za-z0-9_]+)/g)).map(m => m[1]);
    // eslint-disable-next-line no-console
    console.log(`[x-thread] handles=${handles.join(', ')}`);
    expect(new Set(handles).size, 'replies come from other accounts').toBeGreaterThan(1);

    // The cast carries the conversation too, not just the focused tweet.
    expect(bodyText).toContain('Replies');

    // Render through the real /clips view and screenshot.
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await libPage.evaluate((c) => {
      const clip = { capture: c, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      const pubkey = new Array(64).fill('a').join('');
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey, authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, cap);
    const row = libPage.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.click();
    const clipBody = libPage.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 15_000 });
    await libPage.waitForTimeout(1_200);

    // The rendered clip must show the reply cards, not just carry them in HTML.
    await expect(clipBody.locator('.tweet-reply').first()).toBeVisible();
    // eslint-disable-next-line no-console
    console.log(`[x-thread] rendered reply cards=${await clipBody.locator('.tweet-reply').count()}`);

    await screenshotClipBody(libPage, clipBody, out('x-thread-rendered.png'));
    await castShotSafe(page, cap, out('x-thread-cast.png'));
  } finally {
    await ctx.close();
  }
});
