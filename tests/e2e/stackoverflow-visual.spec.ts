// Visual-parity check for Stack Overflow question pages.
// Run: $env:SO='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=stackoverflow-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';

const SO_URL =
  process.env.SO_URL ||
  'https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do-in-python';

test.describe.configure({ mode: 'serial' });

test('stackoverflow-visual: capture Q+A, render in /clips, screenshot', async () => {
  test.skip(!process.env.SO, 'set SO=1 to run this');
  test.setTimeout(360_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  // Reuse the warmed-up 'test' profile by default (medium/breitbart established
  // it past Cloudflare). Override with PROFILE=foo for an isolated profile.
  const profile = process.env.PROFILE ?? 'test';
  // Default to HEADED so a Cloudflare challenge can be solved by the human;
  // the persistent profile then keeps you past it on subsequent runs.
  // Override with PWDEBUG_HEADED=0 to force headless.
  const headed = process.env.PWDEBUG_HEADED === '0' ? false : true;
  const { ctx } = await launchWithExtension({ profile, headed });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(SO_URL, { waitUntil: 'load', timeout: 60_000 });
    // Cloudflare warm-up: poll up to 60s for the real question to load. If
    // a verification page is shown, the human can click through during this
    // window (only needed once per profile).
    await page.mouse.move(400, 300);
    await page.mouse.move(500, 400, { steps: 8 });
    // Wait up to 3 minutes — long enough for a human to click the Cloudflare
    // "Verify you are human" checkbox in the visible window.
    let cleared = false;
    for (let i = 0; i < 180; i++) {
      const ready = await page.evaluate(() => !!document.querySelector('#question'));
      if (ready) { cleared = true; break; }
      if (i % 15 === 0) {
        // eslint-disable-next-line no-console
        console.log(`[probe] waiting for SO content past Cloudflare (${i}s)… click "Verify you are human" if it's showing.`);
      }
      await page.waitForTimeout(1_000);
    }
    if (!cleared) {
      // eslint-disable-next-line no-console
      console.warn('[probe] #question not detected after 180s — Cloudflare still blocking.');
    }
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: out('stackoverflow-source.png'), fullPage: false });

    const struct = await page.evaluate(() => {
      const lines: string[] = [];
      const sels = ['#question', '#answers', '.answer', '.question', '.post-text', '.s-prose', '#mainbar', '.user-info', 'pre code'];
      sels.forEach((s) => {
        const all = document.querySelectorAll(s);
        if (all.length === 0) { lines.push(`${s} → 0`); return; }
        const r = (all[0] as HTMLElement).getBoundingClientRect();
        lines.push(`${s} → count=${all.length} first <${all[0].tagName.toLowerCase()}> x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
      });
      return lines.join('\n');
    });
    writeFileSync(out('stackoverflow-structure.txt'), struct, 'utf8');

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

    await screenshotClipBody(libPage, clipBody, out('stackoverflow-rendered.png'));

    // Third artifact: the PUBLIC cast render (kind-30023 markdown), built by the
    // extension's real BUILD_CAST path from this same capture.
    await castShotSafe(page, cap as { title?: string }, out('stackoverflow-cast.png'));

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    writeFileSync(out('stackoverflow-rendered.html'), html, 'utf8');
    writeFileSync(out('stackoverflow-rendered-stripped.html'), stripped, 'utf8');

    // Structural health checks (after screenshots so artifacts survive a fail).
    await assertClipBodyHealth(clipBody);

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved stackoverflow-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
