// Visual verification of embedded-tweet rendering.
// Loads a real article (zerohedge.com by default) that contains widgets.js
// tweet embeds, captures it through the dev test-bridge, renders the result
// in the web app's /library, and screenshots the resulting clip-body.
//
// Run with: EMBED=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=embedded-tweet-visual
//
// Override the URL with EMBED_URL=... if zerohedge moves the article.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const EMBED_URL =
  process.env.EMBED_URL ||
  'https://www.zerohedge.com/geopolitical/brief-exchange-top-us-cuban-military-leaders-meet-edge-guantanamo-base';

test.describe.configure({ mode: 'serial' });

test('embedded-tweet: capture article with widgets.js tweets, render in library, screenshot', async () => {
  test.skip(!process.env.EMBED, 'set EMBED=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Discerned') || msg.text().includes('embedded') || msg.text().includes('harvest')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, msg.text());
      }
    });
    await page.goto(EMBED_URL, { waitUntil: 'load', timeout: 60_000 });

    // Scroll the whole page to force lazy widgets.js iframes to render.
    await page.evaluate(async () => {
      await new Promise<void>((resolveScroll) => {
        let y = 0;
        const step = () => {
          window.scrollTo(0, y);
          y += 400;
          if (y < document.body.scrollHeight + 800) setTimeout(step, 120);
          else { window.scrollTo(0, 0); setTimeout(() => resolveScroll(), 800); }
        };
        step();
      });
    });
    await page.waitForTimeout(6_000);

    // Count tweet iframes in the page so we know what to expect.
    const tweetIframeCount = await page.evaluate(() =>
      document.querySelectorAll('iframe[id^="twitter-widget"]').length
    );
    // eslint-disable-next-line no-console
    console.log(`[probe] Found ${tweetIframeCount} twitter-widget iframe(s) on the source page`);
    expect(tweetIframeCount, 'source page should have at least one tweet embed').toBeGreaterThan(0);

    await page.screenshot({ path: out('embed-source.png'), fullPage: false });

    // Capture via the dev test bridge (production-code path; __DISCERNED_TEST_BUILD__ enabled in dist-test).
    const cap = (await page.evaluate(async () => {
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
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    // Dump the capture's bodyHtml so we can verify the tweet-card markup.
    writeFileSync(out('embed-capture.json'), JSON.stringify(cap, null, 2), 'utf8');
    const bodyHtml = (cap.bodyHtml as string) ?? '';

    // ── Structural assertions ─────────────────────────────────────────────────
    const cardMatches = bodyHtml.match(/class="[^"]*\btweet-card\b/g) ?? [];
    // eslint-disable-next-line no-console
    console.log(`[probe] tweet-card occurrences in bodyHtml: ${cardMatches.length}`);
    expect(cardMatches.length, 'expected at least one tweet-card in the captured bodyHtml').toBeGreaterThanOrEqual(1);
    // We expect one card per iframe (allowing dedupe to collapse 1 blockquote + 1 iframe per tweet to 1 card).
    expect(cardMatches.length).toBeLessThanOrEqual(tweetIframeCount + 1);

    // No raw <iframe> survives sanitisation+substitution.
    expect(bodyHtml).not.toMatch(/<iframe[\s>]/i);

    // Each card should carry a tweet-handle.
    expect(bodyHtml).toMatch(/class="tweet-handle"[^>]*>@\w+/);

    // The tweet-date footer link should be present (status URL).
    expect(bodyHtml).toMatch(/class="tweet-date"[^>]*href="[^"]*\/status\/\d+/);

    // ── Render through the web app ────────────────────────────────────────────
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/library', { waitUntil: 'networkidle' });

    await libPage.evaluate((capture) => {
      const clip = { capture, evaluation: { interest: 'Interesting', ethics: 'Honest', category: 'General' }, encrypted: '' };
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
        window.location.origin,
      );
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] },
        window.location.origin,
      );
    }, cap);

    const row = libPage.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();

    const clipBody = libPage.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
    await libPage.waitForTimeout(1500);

    // Sanity: locator-based check that tweet cards rendered in the DOM.
    const renderedCardCount = await clipBody.locator('.tweet-card').count();
    // eslint-disable-next-line no-console
    console.log(`[probe] Rendered .tweet-card count in /library: ${renderedCardCount}`);
    expect(renderedCardCount, 'tweet cards should render in /library').toBeGreaterThanOrEqual(1);

    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.setViewportSize({ width: 1280, height: Math.ceil(rect.height) + 100 });
      await libPage.waitForTimeout(500);
    }
    await clipBody.screenshot({ path: out('embed-rendered.png') });

    // Screenshot every tweet card for tight visual comparison.
    const allCards = clipBody.locator('.tweet-card');
    const cardCount = await allCards.count();
    for (let i = 0; i < cardCount; i++) {
      await allCards.nth(i).screenshot({ path: out(`embed-card-${i}.png`) });
    }

    // Screenshot the dx-stats--end row (engagement footer) if present.
    const statsRow = clipBody.locator('.dx-stats--end').first();
    if (await statsRow.count() > 0) {
      const rowBox = await statsRow.boundingBox();
      if (rowBox) {
        await libPage.screenshot({
          path: out('embed-stats-row.png'),
          clip: { x: Math.max(0, rowBox.x - 20), y: Math.max(0, rowBox.y - 20), width: Math.min(1280, rowBox.width + 40), height: rowBox.height + 40 },
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log('[probe] Artifacts written:');
    console.log('  test-output/embed-source.png        (source article screenshot)');
    console.log('  test-output/embed-rendered.png      (rendered clip-body in /library)');
    console.log('  test-output/embed-first-card.png    (close-up of first tweet card)');
    console.log('  test-output/embed-capture.json      (raw capture payload)');
  } finally {
    await ctx.close();
  }
});
