// Does the LIVE bsky page expose a publishable thumbnail URL for a GIF?
//
// The API (app.bsky.feed.getPostThread) returns, per GIF, an
// `external.thumb` on cdn.bsky.app plus the original .gif on static.klipy.com
// — both real https URLs, which is exactly what a CAST needs (it publishes
// only http(s); a canvas frame is a data: URI and gets dropped). The question
// is whether the PAGE carries either, since the capture pipeline reads the DOM
// and not the API.
//
// Reports, per GIF video: the poster/src, any klipy or cdn.bsky URL anywhere
// in its subtree or ancestors (attributes included), and what the surrounding
// markup holds.
//
// Run: BGT=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bsky-gifthumb-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.BGT_URL
  ?? 'https://bsky.app/profile/tiredsleepyzzz.bsky.social/post/3mvpot4yxlc2o';

test('bsky-gifthumb-probe', async () => {
  test.skip(!process.env.BGT, 'set BGT=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(7000);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);

    const report = await page.evaluate(() => {
      const out: string[] = [];
      const klipyAll = new Set<string>();
      const thumbAll = new Set<string>();
      // Scan EVERY attribute on every element — a thumbnail may sit in a
      // data-* attribute or a style background rather than an <img src>.
      document.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((a) => {
          const v = a.value;
          if (/static\.klipy\.com/.test(v)) klipyAll.add(`${el.tagName}[${a.name}] ${v.slice(0, 95)}`);
          if (/cdn\.bsky\.app\/img\/feed_thumbnail/.test(v)) thumbAll.add(`${el.tagName}[${a.name}] ${v.slice(0, 95)}`);
        });
      });
      out.push(`klipy URLs anywhere in DOM: ${klipyAll.size}`);
      Array.from(klipyAll).slice(0, 8).forEach(k => out.push(`  ${k}`));
      out.push(`feed_thumbnail URLs anywhere in DOM: ${thumbAll.size}`);
      Array.from(thumbAll).slice(0, 8).forEach(k => out.push(`  ${k}`));

      out.push('');
      document.querySelectorAll('video').forEach((v, i) => {
        out.push(`=== video[${i}] ===`);
        out.push(`  aria-label: ${v.getAttribute('aria-label') ?? '-'}`);
        // Walk up and look for any usable image URL nearby.
        let scope: Element | null = v;
        for (let d = 0; d < 8 && scope; d++) {
          const found: string[] = [];
          scope.querySelectorAll('img').forEach(im => found.push(`img src=${(im.getAttribute('src') ?? '').slice(0, 80)}`));
          Array.from(scope.querySelectorAll<HTMLElement>('[style*="background-image"]')).forEach(e =>
            found.push(`bg ${e.style.backgroundImage.slice(0, 80)}`));
          if (found.length) { out.push(`  at depth ${d}: ${found.join(' | ')}`); break; }
          scope = scope.parentElement;
        }
        // Does an ancestor <a> point at the original gif?
        const a = v.closest('a');
        out.push(`  ancestor <a> href: ${a?.getAttribute('href')?.slice(0, 80) ?? 'none'}`);
      });
      // Is the API response cached anywhere in the page (hydration payload)?
      out.push('');
      out.push(`__NEXT/hydration script with klipy: ${
        Array.from(document.querySelectorAll('script')).some(s => /klipy/.test(s.textContent ?? ''))}`);
      // The hydration payload carries the ORIGINAL .gif plus its thumb. A .gif
      // is a real https IMAGE that animates, so it is publishable in a cast
      // exactly as-is — unlike the canvas frame (data:) or the .mp4.
      const scripts = Array.from(document.querySelectorAll('script'))
        .map(s => s.textContent ?? '').join('\n');
      const gifs = Array.from(new Set(
        (scripts.match(/https?:\\?\/\\?\/static\.klipy\.com\\?\/[^"'\\\s]+/g) ?? [])
          .map(u => u.replace(/\\\//g, '/'))));
      out.push(`\nklipy .gif URLs in hydration payload: ${gifs.length}`);
      gifs.slice(0, 10).forEach(g => out.push(`  ${g.slice(0, 110)}`));
      // And whether each GIF's aria-label appears near its URL, which is how a
      // URL could be matched to the right video.
      const labels = Array.from(document.querySelectorAll('video'))
        .map(v => v.getAttribute('aria-label') ?? '').filter(Boolean);
      out.push(`\nvideo labels present in payload:`);
      labels.forEach(l => out.push(`  "${l}": ${scripts.includes(l)}`));
      return out.join('\n');
    });

    const dir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'bsky-gifthumb-probe.txt'), report, 'utf8');
    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    await ctx.close();
  }
});
