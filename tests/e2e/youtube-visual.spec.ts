// Visual-parity check for YouTube watch pages.
// Loads a real YouTube video page, captures via the extension, renders the
// clip through /clips, and screenshots both source and rendered.
//
// Run: $env:YOUTUBE='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=youtube-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody } from './helpers/clipShot';

const YT_URL =
  process.env.YOUTUBE_URL ||
  'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" — first YouTube video, evergreen

test.describe.configure({ mode: 'serial' });

test('youtube-visual: capture watch page, render in /clips, screenshot', async () => {
  test.skip(!process.env.YOUTUBE, 'set YOUTUBE=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const profile = process.env.PROFILE ?? 'youtube';
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
    await page.goto(YT_URL, { waitUntil: 'load', timeout: 60_000 });
    // YouTube hydrates async; wait for title + description region.
    await page.waitForSelector('h1.ytd-watch-metadata, h1.title', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: out('youtube-source.png'), fullPage: false });

    // Dump structural landmarks so we can choose tagger anchors.
    const struct = await page.evaluate(() => {
      const lines: string[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('ytd-watch-flexy, #primary, #primary-inner, #above-the-fold, #title, #description, #description-inline-expander, #comments, ytd-comments, ytd-comment-thread-renderer').forEach((el) => {
        const id = el.id || el.tagName.toLowerCase();
        if (seen.has(id)) return;
        seen.add(id);
        const r = (el as HTMLElement).getBoundingClientRect();
        lines.push(`<${el.tagName.toLowerCase()} id="${el.id}"> x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)} childCount=${el.children.length}`);
      });
      return lines.join('\n');
    });
    writeFileSync(out('youtube-structure.txt'), struct, 'utf8');

    // Capture via dev test bridge.
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

    // Render in /clips.
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

    await screenshotClipBody(libPage, clipBody, out('youtube-rendered.png'));

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    writeFileSync(out('youtube-rendered.html'), html, 'utf8');
    writeFileSync(out('youtube-rendered-stripped.html'), stripped, 'utf8');

    // Structural health checks (after screenshots so artifacts survive a fail).
    await assertClipBodyHealth(clipBody);

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved youtube-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
