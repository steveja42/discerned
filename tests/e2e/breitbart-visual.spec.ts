// Headed visual verification of the LIVE Breitbart article.
// Tests that nested platform.twitter.com iframes inside Breitbart wrapper
// iframes get harvested by EXTRACT_EMBEDDED_TWEETS and that the resulting
// tweet-cards get full data (not stubs).
//
// Run with: BB_VISUAL=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=breitbart-visual

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody } from './helpers/clipShot';

const URL =
  process.env.BB_URL ||
  'https://www.breitbart.com/border/2026/06/02/mexican-president-tells-u-s-ambassador-to-butt-out-regarding-narco-politicians/';

test('breitbart-visual: capture live article via headed Brave', async () => {
  test.skip(!process.env.BB_VISUAL, 'set BB_VISUAL=1 to run this');
  test.setTimeout(240_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (n: string) => resolve(outDir, n);

  const profile = process.env.PROFILE ?? 'test';
  const { ctx } = await launchWithExtension({ profile, headed: true });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('harvest') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    // Scroll to force lazy iframes
    await page.evaluate(async () => {
      await new Promise<void>(r => {
        let y = 0;
        const step = () => {
          window.scrollTo(0, y);
          y += 400;
          if (y < document.body.scrollHeight + 800) setTimeout(step, 120);
          else { window.scrollTo(0, 0); setTimeout(() => r(), 600); }
        };
        step();
      });
    });
    // Wait for nested tweet iframes to fully hydrate. The widgets.js render
    // is gated on multiple cross-frame handshakes (Breitbart wrapper →
    // platform.twitter.com outer → embed Tweet.html).
    await page.waitForTimeout(10_000);

    const iframeCount = await page.evaluate(() =>
      document.querySelectorAll('iframe[src*="/tweet-"]').length
    );
    // eslint-disable-next-line no-console
    console.log(`[probe] Breitbart tweet wrapper iframes: ${iframeCount}`);

    await page.screenshot({ path: out('bb-source.png'), fullPage: false });

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

    writeFileSync(out('bb-live-capture.json'), JSON.stringify(cap, null, 2), 'utf8');
    const stripped = { ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').replace(/data:image\/[^"]+/g, 'IMG_INLINED') };
    writeFileSync(out('bb-live-capture-clean.json'), JSON.stringify(stripped, null, 2), 'utf8');

    expect(cap.title, 'capture should not be Cloudflare interstitial').not.toContain('moment');

    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await libPage.evaluate((capture) => {
      const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, cap);
    const row = libPage.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const clipBody = libPage.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
    await libPage.waitForTimeout(1500);

    const tweetCardCount = await clipBody.locator('.tweet-card').count();
    const dxByline = await clipBody.locator('.dx-byline').count();
    // eslint-disable-next-line no-console
    console.log(`[probe] rendered: ${tweetCardCount} tweet-cards, ${dxByline} dx-byline`);

    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.setViewportSize({ width: 1280, height: Math.min(2400, Math.ceil(rect.height) + 100) });
      await libPage.waitForTimeout(500);
    }
    await libPage.screenshot({
      path: out('bb-live-rendered-top.png'),
      clip: { x: 0, y: 0, width: 1280, height: 1200 },
    });
    await screenshotClipBody(libPage, clipBody, out('bb-live-rendered-full.png'));

    // Structural health checks (after screenshots so artifacts survive a fail).
    await assertClipBodyHealth(clipBody);
  } finally {
    await ctx.close();
  }
});
