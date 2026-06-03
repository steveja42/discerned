// Probe: run the same extractor function we ship into the video iframe
// (frame 0) and report what it returns, including which condition caused
// an early null return.

import { test } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';

const URL =
  process.env.BB_URL ||
  'https://www.breitbart.com/border/2026/06/02/mexican-president-tells-u-s-ambassador-to-butt-out-regarding-narco-politicians/';

test('extractor-frame0-probe', async () => {
  test.skip(process.env.FRAME0 !== '1', 'set FRAME0=1');
  test.setTimeout(180_000);

  const profile = process.env.PROFILE ?? 'test';
  const { ctx } = await launchWithExtension({ profile, headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate(async () => {
      await new Promise<void>(r => {
        let y = 0;
        const step = () => {
          window.scrollTo(0, y);
          y += 400;
          if (y < document.body.scrollHeight + 800) setTimeout(step, 100);
          else { window.scrollTo(0, 0); setTimeout(() => r(), 600); }
        };
        step();
      });
    });
    await page.waitForTimeout(12_000);

    const tweetFrames = page.frames().filter(f => /platform\.twitter\.com\/embed\/Tweet\.html/.test(f.url()));
    // eslint-disable-next-line no-console
    console.log(`Frames: ${tweetFrames.length}`);
    for (let i = 0; i < tweetFrames.length; i++) {
      const f = tweetFrames[i];
      const result = await f.evaluate(() => {
        const out: Record<string, unknown> = {};
        try {
          const article = document.querySelector('article') ?? document.body;
          out.articleFound = !!article;
          out.articleTag = article.tagName.toLowerCase();
          const statusAnchor = article.querySelector('a[aria-label="Visit this post on X"]') as HTMLAnchorElement | null
            ?? (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null);
          out.statusAnchorFound = !!statusAnchor;
          const rawStatus = statusAnchor?.getAttribute('href') ?? '';
          out.rawStatus = rawStatus.slice(0, 200);
          const statusUrl = rawStatus.split('?')[0] ?? '';
          out.statusUrl = statusUrl;
          const tweetIdMatch = statusUrl.match(/\/status\/(\d+)/);
          const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';
          out.tweetId = tweetId;
          if (!tweetId) { out.earlyReturn = 'tweetId empty'; return out; }
          const avatarContainer = article.querySelector('[data-testid^="UserAvatar-Container-"]');
          let handle = (avatarContainer?.getAttribute('data-testid') ?? '').replace(/^UserAvatar-Container-/, '');
          if (!handle) {
            const handleFromUrl = statusUrl.match(/\/\/(?:twitter|x)\.com\/([^/]+)\/status\//i);
            if (handleFromUrl) handle = handleFromUrl[1];
          }
          out.handle = handle;
          const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
          out.tweetTextFound = !!tweetTextEl;
          const videos = Array.from(article.querySelectorAll('video[poster]'));
          out.videos = videos.map(v => v.getAttribute('poster'));
          const photos = Array.from(article.querySelectorAll('a[href*="/photo/"] img')).map(im => (im as HTMLImageElement).src);
          out.photos = photos;
          return out;
        } catch (e) {
          out.error = String(e);
          return out;
        }
      });
      // eslint-disable-next-line no-console
      console.log(`\nFrame ${i} url:`, f.url().slice(0, 120));
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await ctx.close();
  }
});
