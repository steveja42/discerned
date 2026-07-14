// Visual-parity check for BBC News article pages.
// Run: $env:BBC='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bbc-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';

const BBC_URL =
  process.env.BBC_URL ||
  'https://www.bbc.com/news/articles/c0kgydkr516o';

test.describe.configure({ mode: 'serial' });

test('bbc-visual: capture article, render in /clips, screenshot', async () => {
  test.skip(!process.env.BBC, 'set BBC=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const profile = process.env.PROFILE ?? 'bbc';
  const { ctx } = await launchWithExtension({ profile, headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(BBC_URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('article, main', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: out('bbc-source.png'), fullPage: false });

    const struct = await page.evaluate(() => {
      const lines: string[] = [];
      const sels = ['article', 'main', '[role="main"]', '[data-component="text-block"]', '[data-component="image-block"]', '[data-component="headline-block"]', 'figure', 'time'];
      sels.forEach((s) => {
        const all = document.querySelectorAll(s);
        if (all.length === 0) { lines.push(`${s} → 0`); return; }
        const r = (all[0] as HTMLElement).getBoundingClientRect();
        lines.push(`${s} → count=${all.length} first <${all[0].tagName.toLowerCase()}> x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
      });
      return lines.join('\n');
    });
    writeFileSync(out('bbc-structure.txt'), struct, 'utf8');

    const cap = (await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('capture timeout')), 30_000);
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.capture);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as Record<string, unknown>;

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
    await libPage.waitForTimeout(1000);

    await screenshotClipBody(libPage, clipBody, out('bbc-rendered.png'));

    // Third artifact: the PUBLIC cast render (kind-30023 markdown), built by the
    // extension's real BUILD_CAST path from this same capture.
    await castShotSafe(page, cap as { title?: string }, out('bbc-cast.png'));

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    writeFileSync(out('bbc-rendered.html'), html, 'utf8');
    writeFileSync(out('bbc-rendered-stripped.html'), stripped, 'utf8');

    // Structural health checks (after screenshots so artifacts survive a fail).
    await assertClipBodyHealth(clipBody);

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved bbc-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
