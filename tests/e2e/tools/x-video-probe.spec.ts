// Why did a VIDEO tweet capture as a flat <img> with no play card?
//
// extractTweetBlock has three video-detection paths (tweetPhoto containers,
// aria-label media wrappers, then a bare <video poster> scan). A reply in
// x.com/BitcoinMagazine/status/2100262527011545441 rendered as a still image
// with no tweet-video anchor, so none of them matched. This reports, per
// article on the page, what media elements actually exist and what each one
// carries — poster, src scheme, wrappers, and the aria-labels/testids nearby.
//
// Run: XVID=1 [XVID_URL=<url>] pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=x-video-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.XVID_URL ?? 'https://x.com/BitcoinMagazine/status/2100262527011545441';

test('x-video-probe', async () => {
  test.skip(!process.env.XVID, 'set XVID=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(7000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);

    const report = await page.evaluate(() => {
      const out: string[] = [];
      const arts = Array.from(document.querySelectorAll('article'));
      out.push(`articles: ${arts.length}`);
      arts.forEach((a, i) => {
        const txt = (a.querySelector('div[dir="auto"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
        out.push(`\n=== article[${i}] "${txt}" ===`);
        const vids = Array.from(a.querySelectorAll('video'));
        out.push(`  <video>: ${vids.length}`);
        vids.forEach((v, j) => {
          out.push(`    video[${j}] poster="${(v.getAttribute('poster') ?? 'NONE').slice(0, 70)}"`);
          out.push(`      src="${(v.getAttribute('src') ?? 'none').slice(0, 45)}" currentSrc="${(v.currentSrc ?? '').slice(0, 45)}"`);
          out.push(`      sources=${Array.from(v.querySelectorAll('source')).map(s => (s.getAttribute('src') ?? '').slice(0, 40)).join(' | ') || 'none'}`);
          const r = v.getBoundingClientRect();
          out.push(`      rect=${Math.round(r.width)}x${Math.round(r.height)}`);
          // What wrappers does the detection code look for?
          out.push(`      closest[data-testid=videoPlayer]=${!!v.closest('[data-testid="videoPlayer"]')}`);
          out.push(`      closest[data-testid=tweetPhoto]=${!!v.closest('[data-testid="tweetPhoto"]')}`);
          out.push(`      closest a[aria-label]=${v.closest('a[aria-label]')?.getAttribute('aria-label') ?? 'none'}`);
        });
        // Media-ish links + any duration badge, which is how a video post is
        // told apart from a photo post when there is no <video> at all.
        const mediaLinks = Array.from(a.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'))
          .map(x => x.getAttribute('href') ?? '');
        out.push(`  media links: ${mediaLinks.join(' , ') || 'none'}`);
        const durations = Array.from(a.querySelectorAll('span'))
          .map(s => (s.textContent ?? '').trim())
          .filter(t => /^\d+:\d{2}$/.test(t));
        out.push(`  duration badges: ${durations.join(' , ') || 'none'}`);
        const imgs = Array.from(a.querySelectorAll('img'));
        out.push(`  <img>: ${imgs.length}`);
        imgs.forEach((im, j) => {
          const r = im.getBoundingClientRect();
          out.push(`    img[${j}] ${Math.round(r.width)}x${Math.round(r.height)} src="${im.getAttribute('src')?.slice(0, 60)}"`);
        });
        out.push(`  aria-labels: ${Array.from(a.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label')).filter(Boolean).slice(0, 12).join(' | ')}`);
      });
      return out.join('\n');
    });

    const dir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'x-video-probe.txt'), report, 'utf8');
    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    await ctx.close();
  }
});
