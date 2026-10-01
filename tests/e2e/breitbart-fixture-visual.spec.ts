// Local Breitbart fixture capture + render for offline iteration.
// Run with: BB_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=breitbart-fixture-visual

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';

const FIXTURE_URL = 'http://127.0.0.1:4173/breitbart-article.html';

test.describe.configure({ mode: 'serial' });

test('breitbart-fixture-visual', async () => {
  test.skip(!process.env.BB_FIX, 'set BB_FIX=1');
  test.setTimeout(120_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (n: string) => resolve(outDir, n);

  const { ctx } = await launchWithExtension({ headed: !!process.env.PWDEBUG_HEADED });
  // The embeds never render here, so their cards are filled from X's syndication
  // JSON — served from saved copies (and the images they name) for a stable baseline.
  const SYND = resolve(__dirname, '..', 'fixtures', 'syndication');
  await ctx.route('**://cdn.syndication.twimg.com/**', (route) => {
    const file = resolve(SYND, `${new URL(route.request().url()).searchParams.get('id')}.json`);
    return existsSync(file) ? route.fulfill({ path: file, contentType: 'application/json' }) : route.abort();
  });
  await ctx.route('**://pbs.twimg.com/**', (route) => {
    const file = resolve(SYND, new URL(route.request().url()).pathname.slice(1).replace(/\//g, '_'));
    return existsSync(file) ? route.fulfill({ path: file, contentType: 'image/jpeg' }) : route.abort();
  });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Wirthy') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(FIXTURE_URL, { waitUntil: 'load', timeout: 30_000 });
    // The content script is injected on the activation gesture (there is no
    // static content_scripts entry), so trigger it before the test bridge.
    await activateExtensionOnTab(ctx, FIXTURE_URL);

    const cap = (await page.evaluate(async () => {
      return new Promise((resolveCap, rejectCap) => {
        const timer = setTimeout(() => rejectCap(new Error('capture timeout')), 30_000);
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type !== '__WIRTHY_TEST_CAPTURE_RESULT') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (e.data.error) rejectCap(new Error(e.data.error));
          else resolveCap(e.data.capture);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ type: '__WIRTHY_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    writeFileSync(out('bb-fixture-capture.json'),
      JSON.stringify(cap, null, 2),
      'utf8');
    // Also write a base64-stripped version for human inspection.
    const stripped = { ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').replace(/data:image\/[^"]+/g, 'IMG_INLINED') };
    writeFileSync(out('bb-fixture-capture-clean.json'), JSON.stringify(stripped, null, 2), 'utf8');

    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await libPage.evaluate((capture) => {
      const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'WIRTHY_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'WIRTHY_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
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
    // Fit the whole clip in the viewport — the scrolling panel leaves anything
    // below its visible area unpainted in an element screenshot.
    await libPage.waitForLoadState('networkidle');
    const clipH = Math.ceil((await clipBody.boundingBox())?.height ?? 1200);
    await libPage.setViewportSize({ width: 1280, height: clipH + 400 });
    await libPage.waitForTimeout(500);
    await expect(clipBody).toHaveScreenshot('breitbart-fixture-clipbody.png', { maxDiffPixelRatio: 0.02 });
  } finally {
    await ctx.close();
  }
});
