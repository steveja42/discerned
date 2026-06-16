// Verifies that selection and full-page clips on twitter.com / x.com produce
// readable output. The article-format path on x.com already uses Tier 0 to
// render rich tweet-cards; this spec exercises the other two formats.
//
// Run with: TWITTER=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=twitter-clip-modes

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const TWEET_URL =
  process.env.TWEET_URL ||
  // Use the same CIA tweet we know exists; this should be stable enough.
  'https://x.com/CIA/status/2055074954375254084';

test.describe.configure({ mode: 'serial' });

test('twitter: full-page capture produces readable bodyHtml', async () => {
  test.skip(!process.env.TWITTER, 'set TWITTER=1 to run this');
  test.setTimeout(120_000);

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
    await page.goto(TWEET_URL, { waitUntil: 'load', timeout: 60_000 });
    // x.com hydrates client-side; give it a moment.
    await page.waitForTimeout(5_000);

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
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'full-page' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    writeFileSync(out('twitter-fullpage-capture.json'), JSON.stringify({ ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').slice(0, 50000) }, null, 2), 'utf8');
    const bodyHtml = (cap.bodyHtml as string) ?? '';
    const bodyText = (cap.bodyText as string) ?? '';

    expect(cap.format).toBe('full-page');
    // We now route full-page on x.com through Tier 0 — output should be a
    // single tweet-card, not a multi-megabyte page dump.
    expect(bodyHtml).toMatch(/class="tweet-card\b/);
    expect(bodyHtml).toMatch(/class="tweet-handle"[^>]*>@CIA/);
    expect(bodyText).toContain('Havana');
    expect(bodyText).toContain('@CIA');
    // Tweet-card output is ~tens of KB (mostly inlined images), not 100s of KB.
    expect(bodyHtml.length, 'bodyHtml is now a tweet-card, not full DOM').toBeLessThan(1_000_000);

    // eslint-disable-next-line no-console
    console.log(`[probe] full-page bodyText len=${bodyText.length} bodyHtml len=${bodyHtml.length}`);

    // Render through /clips and screenshot the resulting card.
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
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
    await libPage.waitForTimeout(1500);
    const card = clipBody.locator('.tweet-card').first();
    await card.screenshot({ path: out('twitter-fullpage-rendered.png') });
  } finally {
    await ctx.close();
  }
});

test('twitter: selection capture across the tweet text produces readable selectionText', async () => {
  test.skip(!process.env.TWITTER, 'set TWITTER=1 to run this');
  test.setTimeout(120_000);

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
    await page.goto(TWEET_URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(5_000);

    // Select the tweet text. On x.com the tweet body is at [data-testid="tweetText"].
    await page.evaluate(() => {
      const tweetEl = document.querySelector('[data-testid="tweetText"]');
      if (!tweetEl) throw new Error('no tweetText element');
      const range = document.createRange();
      range.selectNodeContents(tweetEl);
      const sel = window.getSelection();
      if (!sel) throw new Error('no Selection');
      sel.removeAllRanges();
      sel.addRange(range);
    });
    // Give the page a beat to register the selection before the capture click.
    await page.waitForTimeout(300);

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
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'selection' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    writeFileSync(out('twitter-selection-capture.json'), JSON.stringify(cap, null, 2), 'utf8');
    const selText = (cap.selectionText as string) ?? '';

    expect(cap.format).toBe('selection');
    // Selection on x.com inside a tweet article should now return the whole
    // tweet-card, not the bare selected fragment.
    expect(selText).toMatch(/class="tweet-card\b/);
    expect(selText).toMatch(/class="tweet-handle"[^>]*>@CIA/);
    expect(selText).toContain('Havana');
    // eslint-disable-next-line no-console
    console.log(`[probe] selection selectionText len=${selText.length}`);

    // Render through /clips and screenshot.
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
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
    await libPage.waitForTimeout(1500);
    const card = clipBody.locator('.tweet-card').first();
    await card.screenshot({ path: out('twitter-selection-rendered.png') });
  } finally {
    await ctx.close();
  }
});
