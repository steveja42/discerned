// Visual-parity check for Wikipedia article pages.
// Run: $env:WIKIPEDIA='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=wikipedia-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const WP_URL =
  process.env.WIKIPEDIA_URL ||
  'https://en.wikipedia.org/wiki/Bitcoin';

test.describe.configure({ mode: 'serial' });

test('wikipedia-visual: capture article, render in /library, screenshot', async () => {
  test.skip(!process.env.WIKIPEDIA, 'set WIKIPEDIA=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const profile = process.env.PROFILE ?? 'wikipedia';
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
    await page.goto(WP_URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('#mw-content-text, .mw-parser-output', { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: out('wikipedia-source.png'), fullPage: false });

    const struct = await page.evaluate(() => {
      const lines: string[] = [];
      const sels = ['#bodyContent', '#content', '#mw-content-text', '.mw-parser-output', '.infobox', '#toc', '.references', '#firstHeading', '.mw-page-title-main'];
      sels.forEach((s) => {
        const el = document.querySelector(s);
        if (!el) { lines.push(`${s} → (no match)`); return; }
        const r = (el as HTMLElement).getBoundingClientRect();
        lines.push(`${s} → <${el.tagName.toLowerCase()}> x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)} childCount=${el.children.length}`);
      });
      return lines.join('\n');
    });
    writeFileSync(out('wikipedia-structure.txt'), struct, 'utf8');

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

    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.setViewportSize({ width: 1280, height: Math.min(Math.ceil(rect.height) + 100, 8000) });
      await libPage.waitForTimeout(500);
    }
    await clipBody.screenshot({ path: out('wikipedia-rendered.png') });

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    writeFileSync(out('wikipedia-rendered.html'), html, 'utf8');
    writeFileSync(out('wikipedia-rendered-stripped.html'), stripped, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved wikipedia-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
