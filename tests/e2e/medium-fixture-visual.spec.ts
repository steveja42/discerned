// Visual verification of Medium-style article capture using a LOCAL fixture
// (tests/fixtures/sites/medium-article.html). No Cloudflare, no network — runs
// instantly and lets us iterate on dx-header / dx-byline-meta / dx-stats CSS.
//
// Run with: MED_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=medium-fixture-visual

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const FIXTURE_URL = 'http://127.0.0.1:4173/medium-article.html';

test.describe.configure({ mode: 'serial' });

test('medium-fixture-visual: capture local Medium fixture + render in /clips', async () => {
  test.skip(!process.env.MED_FIX, 'set MED_FIX=1 to run this');
  test.setTimeout(120_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

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

    writeFileSync(out('medium-fixture-capture.json'),
      JSON.stringify({ ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').slice(0, 50000) }, null, 2),
      'utf8');

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
    await libPage.waitForTimeout(1000);

    await libPage.setViewportSize({ width: 1280, height: 1200 });
    await libPage.waitForTimeout(300);
    await libPage.screenshot({
      path: out('medium-fixture-rendered.png'),
      clip: { x: 0, y: 0, width: 1280, height: 1000 },
    });

    const dxInfo = await clipBody.evaluate(root => {
      const targets = Array.from(root.querySelectorAll('.dx-header, .dx-author, .dx-stats, .dx-byline-meta'));
      return targets.map(el => ({
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
        childCount: el.children.length,
      }));
    });
    // eslint-disable-next-line no-console
    console.log('\n[probe] dx markers:', JSON.stringify(dxInfo, null, 2));
    expect(dxInfo.length, 'at least one dx marker should be stamped').toBeGreaterThan(0);

    // Pixel-diff baseline of the rendered clip body. Regenerate with
    // `--update-snapshots` after intentional visual changes. Snapshot files
    // live next to this spec in tests/e2e/medium-fixture-visual.spec.ts-snapshots/.
    // maxDiffPixelRatio tolerates tiny font-rendering / anti-aliasing wobble.
    await expect(clipBody).toHaveScreenshot('medium-fixture-clipbody.png', { maxDiffPixelRatio: 0.02 });
  } finally {
    await ctx.close();
  }
});
