// Run the EXACT extractor function (copy-pasted) in both tweet frames and
// see what each returns.

import { test } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';

const URL =
  process.env.BB_URL ||
  'https://www.breitbart.com/border/2026/06/02/mexican-president-tells-u-s-ambassador-to-butt-out-regarding-narco-politicians/';

test('extractor-full-probe', async () => {
  test.skip(process.env.FULL_PROBE !== '1', 'set FULL_PROBE=1');
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
        // EXACT copy of extractFromTweetEmbed from background.ts
        try {
          const article = document.querySelector('article') ?? document.body;
          if (!article) return null;
          const statusAnchor = article.querySelector('a[aria-label="Visit this post on X"]') as HTMLAnchorElement | null
            ?? (article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null);
          const rawStatus = statusAnchor?.getAttribute('href') ?? '';
          const statusUrl = rawStatus.split('?')[0] ?? '';
          const tweetIdMatch = statusUrl.match(/\/status\/(\d+)/);
          const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';
          if (!tweetId) return null;
          const avatarContainer = article.querySelector('[data-testid^="UserAvatar-Container-"]');
          let handle = (avatarContainer?.getAttribute('data-testid') ?? '').replace(/^UserAvatar-Container-/, '');
          if (!handle) {
            const handleFromUrl = statusUrl.match(/\/\/(?:twitter|x)\.com\/([^/]+)\/status\//i);
            if (handleFromUrl) handle = handleFromUrl[1];
          }
          const avatarImg = avatarContainer?.querySelector('img');
          const avatarSrc = avatarImg?.getAttribute('src') ?? '';
          const profileLinks = Array.from(article.querySelectorAll('a')) as HTMLAnchorElement[];
          let displayName = '';
          for (const a of profileLinks) {
            const href = a.getAttribute('href') ?? '';
            if (!/\/\/(twitter|x)\.com\//.test(href)) continue;
            if (/\/status\//.test(href)) continue;
            if (/\/hashtag\//.test(href)) continue;
            if (/\/intent\//.test(href)) continue;
            const t = (a.textContent ?? '').trim();
            if (t.length > 0) { displayName = t; break; }
          }
          if (!displayName && handle) displayName = handle;
          const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
          let tweetTextHtml = '';
          if (tweetTextEl) {
            const clone = tweetTextEl.cloneNode(true) as Element;
            clone.querySelectorAll('[data-testid="tweet-text-show-more-link"]').forEach(showMore => {
              if (statusUrl) showMore.setAttribute('href', statusUrl);
            });
            tweetTextHtml = clone.innerHTML;
          }
          const time = article.querySelector('time[datetime]');
          const dateText = time?.textContent?.trim() ?? '';
          const photoSrcsRaw = (Array.from(article.querySelectorAll('a[href*="/photo/"] img')) as HTMLImageElement[])
            .map(img => img.getAttribute('src') ?? '').filter(s => s.length > 0);
          const photoSrcs = Array.from(new Set(photoSrcsRaw));
          const videoEls = Array.from(article.querySelectorAll('video[poster]')) as HTMLVideoElement[];
          const videoInfos = videoEls.map(v => ({
            poster: v.getAttribute('poster') ?? '',
            duration: null,
            aspectPct: null,
          })).filter(v => v.poster);
          const isVerified = !!article.querySelector('[data-testid="icon-verified"]');
          return {
            tweetId, statusUrl, displayName, handle,
            badgesHtml: isVerified ? '[VERIFIED_SVG]' : '',
            tweetTextHtml: tweetTextHtml.slice(0, 200),
            photoSrcs, videoInfos, avatarSrc, dateText,
            source: 'iframe',
          };
        } catch (e) {
          return { error: String(e) };
        }
      });
      // eslint-disable-next-line no-console
      console.log(`\nFrame ${i}:`);
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await ctx.close();
  }
});
