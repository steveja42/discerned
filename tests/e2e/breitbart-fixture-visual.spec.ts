// Local Breitbart fixture capture + render for offline iteration.
// Run with: BB_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=breitbart-fixture-visual

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const FIXTURE_URL = 'http://127.0.0.1:4173/breitbart-article.html';

test.describe.configure({ mode: 'serial' });

test('breitbart-fixture-visual', async () => {
  test.skip(!process.env.BB_FIX, 'set BB_FIX=1');
  test.setTimeout(120_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (n: string) => resolve(outDir, n);

  const { ctx } = await launchWithExtension({ headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(FIXTURE_URL, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(500);

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

    writeFileSync(out('bb-fixture-capture.json'),
      JSON.stringify(cap, null, 2),
      'utf8');
    // Also write a base64-stripped version for human inspection.
    const stripped = { ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').replace(/data:image\/[^"]+/g, 'IMG_INLINED') };
    writeFileSync(out('bb-fixture-capture-clean.json'), JSON.stringify(stripped, null, 2), 'utf8');

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
    await libPage.waitForTimeout(1000);

    await libPage.setViewportSize({ width: 1280, height: 1400 });
    await libPage.waitForTimeout(300);
    await libPage.screenshot({
      path: out('bb-fixture-rendered.png'),
      clip: { x: 0, y: 0, width: 1280, height: 1200 },
    });

    const dx = await clipBody.evaluate(root => {
      const ts = Array.from(root.querySelectorAll('.dx-header, .dx-byline-meta, .dx-stats, .tweet-card, .dx-excl'));
      return ts.map(el => ({ cls: el.className, text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), tag: el.tagName.toLowerCase() }));
    });
    // eslint-disable-next-line no-console
    console.log('[probe] markers:', JSON.stringify(dx, null, 2));
    expect(dx.length, 'at least one dx/tweet marker').toBeGreaterThan(0);

    // Pixel-diff baseline. Regenerate with `--update-snapshots` after
    // intentional visual changes; otherwise this fails on accidental layout
    // regressions to shared CSS or generic taggers.
    await expect(clipBody).toHaveScreenshot('breitbart-fixture-clipbody.png', { maxDiffPixelRatio: 0.02 });
  } finally {
    await ctx.close();
  }
});
