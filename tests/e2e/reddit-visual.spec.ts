// Visual-parity check for Reddit comment threads.
// Run: $env:REDDIT='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=reddit-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const RD_URL =
  process.env.REDDIT_URL ||
  // Stable, freely-accessible thread on r/explainlikeimfive (high-comment, evergreen).
  'https://www.reddit.com/r/explainlikeimfive/comments/171n8na/eli5_why_is_water_wet/';

test.describe.configure({ mode: 'serial' });

test('reddit-visual: capture post + comments, render in /library, screenshot', async () => {
  test.skip(!process.env.REDDIT, 'set REDDIT=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const profile = process.env.PROFILE ?? 'reddit';
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
    await page.goto(RD_URL, { waitUntil: 'load', timeout: 60_000 });
    // New Reddit uses custom elements; wait for the main post.
    await page.waitForSelector('shreddit-post, [data-test-id="post-content"], article', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: out('reddit-source.png'), fullPage: false });

    const struct = await page.evaluate(() => {
      const lines: string[] = [];
      const sels = ['shreddit-post', 'shreddit-comment-tree', 'shreddit-comment', '[slot="title"]', '[slot="text-body"]', '[data-testid="comment"]', 'article', 'main', '#main-content'];
      sels.forEach((s) => {
        const all = document.querySelectorAll(s);
        if (all.length === 0) { lines.push(`${s} → 0`); return; }
        const r = (all[0] as HTMLElement).getBoundingClientRect();
        lines.push(`${s} → count=${all.length} first <${all[0].tagName.toLowerCase()}> x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
      });
      // Count shadow roots
      const shadowCount = (() => {
        let n = 0;
        document.querySelectorAll('*').forEach((el) => { if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) n++; });
        return n;
      })();
      lines.push(`shadow_root_count=${shadowCount}`);
      return lines.join('\n');
    });
    writeFileSync(out('reddit-structure.txt'), struct, 'utf8');

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
    await clipBody.screenshot({ path: out('reddit-rendered.png') });

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    writeFileSync(out('reddit-rendered.html'), html, 'utf8');
    writeFileSync(out('reddit-rendered-stripped.html'), stripped, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved reddit-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
