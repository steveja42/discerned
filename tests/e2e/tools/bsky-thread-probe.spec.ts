// Bluesky thread structure + why reply IMAGES go missing.
//
// bsky.app has NO <article> elements (the X thread probe reports 0), so the
// conversation shape has to be read from its data-testid hooks instead. This
// reports, per post in the thread: the testid that identifies it, the author,
// whether tagBsky's selectors reach it, and — the reported defect — every
// <img> it holds with the size and wrapper, so a dropped reply image can be
// told apart from one that was never in the DOM.
//
// Run: BSKYT=1 [BSKYT_URL=<url>] pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bsky-thread-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.BSKYT_URL
  ?? 'https://bsky.app/profile/tiredsleepyzzz.bsky.social/post/3mvpot4yxlc2o';

test('bsky-thread-probe', async () => {
  test.skip(!process.env.BSKYT, 'set BSKYT=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(7000);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);

    const report = await page.evaluate(() => {
      const out: string[] = [];
      out.push(`URL: ${location.href}`);
      // Census of the testids tagBsky keys on.
      const census: Record<string, number> = {};
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const t = el.getAttribute('data-testid') ?? '';
        // Group the per-post ids (feedItem-by-<handle>) under one key.
        const key = t.replace(/^(feedItem-by|postThreadItem-by)-.*/, '$1-*');
        census[key] = (census[key] ?? 0) + 1;
      });
      out.push('\n=== data-testid census (thread-relevant) ===');
      Object.entries(census)
        .filter(([k]) => /feed|post|thread|reply|content|image|embed/i.test(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .forEach(([k, v]) => out.push(`  ${k}: ${v}`));

      // The posts themselves, in document order.
      const posts = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]'));
      out.push(`\n=== POSTS: ${posts.length} ===`);
      posts.forEach((p, i) => {
        const tid = p.getAttribute('data-testid') ?? '';
        const txt = (p.querySelector('[data-testid="postText"]')?.textContent
          ?? p.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        out.push(`\n[${i}] ${tid}`);
        out.push(`    text="${txt}"`);
        const imgs = Array.from(p.querySelectorAll('img'));
        out.push(`    <img>: ${imgs.length}`);
        imgs.forEach((im, j) => {
          const r = im.getBoundingClientRect();
          const src = im.getAttribute('src') ?? '';
          // avatar vs feed image is decidable from the CDN path on bsky.
          const kind = /avatar/i.test(src) ? 'AVATAR' : /feed_thumbnail|feed_fullsize/i.test(src) ? 'CONTENT' : '?';
          out.push(`      img[${j}] ${kind} ${Math.round(r.width)}x${Math.round(r.height)} src=${src.slice(0, 64)}`);
        });
        // Images can also be CSS backgrounds or inside an embed wrapper.
        const embeds = Array.from(p.querySelectorAll('[data-testid*="mage"], [data-testid*="mbed"]'))
          .map(e => e.getAttribute('data-testid') ?? '');
        if (embeds.length) out.push(`    embed testids: ${embeds.join(' , ')}`);
      });
      return out.join('\n');
    });

    const dir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'bsky-thread-probe.txt'), report, 'utf8');
    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    await ctx.close();
  }
});
