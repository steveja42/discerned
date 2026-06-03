// Probe inside the platform.twitter.com iframe of a tweet that has a video
// (Breitbart wraps it with `-onlyvideo` mode). What does the iframe DOM
// expose? Looking for a <video poster=> or an <img> with a video poster URL.

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const URL =
  process.env.BB_URL ||
  'https://www.breitbart.com/border/2026/06/02/mexican-president-tells-u-s-ambassador-to-butt-out-regarding-narco-politicians/';

test('tweet-video-probe', async () => {
  test.skip(!process.env.TWEET_VIDEO_PROBE, 'set TWEET_VIDEO_PROBE=1');
  test.setTimeout(180_000);
  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

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
    await page.waitForTimeout(8_000);

    // Find platform.twitter.com Tweet.html frames
    const tweetFrames = page.frames().filter(f => /platform\.twitter\.com\/embed\/Tweet\.html/.test(f.url()));
    // eslint-disable-next-line no-console
    console.log(`Found ${tweetFrames.length} platform.twitter.com Tweet.html frames`);
    for (let i = 0; i < tweetFrames.length; i++) {
      const f = tweetFrames[i];
      try {
        const info = await f.evaluate(() => {
          const article = document.querySelector('article');
          if (!article) return { error: 'no article' };
          // Video elements
          const videos = Array.from(article.querySelectorAll('video'));
          const videoData = videos.map(v => ({
            poster: v.getAttribute('poster') ?? '',
            src: v.getAttribute('src') ?? '',
            sourceSrc: v.querySelector('source')?.getAttribute('src') ?? '',
            currentSrc: (v as HTMLVideoElement).currentSrc ?? '',
          }));
          // Any element with poster attribute
          const postered = Array.from(article.querySelectorAll('[poster]')).map(el => ({
            tag: el.tagName.toLowerCase(),
            poster: el.getAttribute('poster'),
          }));
          // Look for amplify_video_thumb or video_thumb URLs in src attributes
          const imgs = Array.from(article.querySelectorAll('img'));
          const allImgs = imgs.map(im => im.src);
          const videoThumbs = allImgs.filter(s => /amplify_video_thumb|video_thumb|tweet_video_thumb|ext_tw_video_thumb/.test(s));
          // Background-image URLs that might be video posters
          const bgImageEls = Array.from(article.querySelectorAll('*')).map(el => {
            const bg = (el as HTMLElement).style?.backgroundImage ?? '';
            const m = bg.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/);
            return m ? m[1] : null;
          }).filter(Boolean);
          const videoBgs = bgImageEls.filter(s => s && /pbs\.twimg\.com|tweet_video|ext_tw_video/.test(s));
          // Show-more link details
          const showMoreLink = article.querySelector('[data-testid="tweet-text-show-more-link"]');
          const showMoreHref = showMoreLink?.getAttribute('href') ?? null;
          const showMoreText = showMoreLink?.textContent?.trim() ?? null;
          // Get status URL for the canonical tweet URL
          const visitOnX = article.querySelector('a[aria-label="Visit this post on X"]') as HTMLAnchorElement | null;
          const statusUrl = visitOnX?.getAttribute('href')?.split('?')[0] ?? null;
          // Tweet-text-show-more often points to twitter t.co or a signin redirect.
          // The canonical https://x.com/{handle}/status/{id} is easier to use.
          // Simulate what our extractor would produce
          const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
          let extractedHtml = '';
          if (tweetTextEl) {
            const clone = tweetTextEl.cloneNode(true) as Element;
            clone.querySelectorAll('[data-testid="tweet-text-show-more-link"]').forEach(showMore => {
              if (statusUrl) showMore.setAttribute('href', statusUrl);
            });
            extractedHtml = clone.innerHTML.slice(0, 1500);
          }
          return {
            videos: videoData,
            postered,
            videoThumbs,
            videoBgs,
            showMoreHref,
            showMoreText,
            statusUrl,
            allImgsSample: allImgs.slice(0, 8),
            extractedTweetTextHtml: extractedHtml,
          };
        });
        // eslint-disable-next-line no-console
        console.log(`\nFrame ${i} (${f.url().slice(0, 100)}):`);
        console.log(JSON.stringify(info, null, 2));
        writeFileSync(resolve(outDir, `tweet-frame-${i}.json`), JSON.stringify(info, null, 2), 'utf8');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`Frame ${i} error:`, e);
      }
    }
  } finally {
    await ctx.close();
  }
});
