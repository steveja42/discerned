// Probe Breitbart article: locate byline, embedded tweets, embedded videos.

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const URL =
  process.env.BB_URL ||
  'https://www.breitbart.com/border/2026/06/02/mexican-president-tells-u-s-ambassador-to-butt-out-regarding-narco-politicians/';

test('breitbart-probe', async () => {
  test.skip(!process.env.BB_PROBE, 'set BB_PROBE=1 to run');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (n: string) => resolve(outDir, n);

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
          else { window.scrollTo(0, 0); setTimeout(() => r(), 500); }
        };
        step();
      });
    });
    await page.waitForTimeout(5_000);

    await page.screenshot({ path: out('bb-source.png'), fullPage: false });

    const dump = await page.evaluate(() => {
      const out: Record<string, unknown> = {};
      // Byline: usually a node with author names + date close to article title.
      // Try common Breitbart selectors first.
      const byline = document.querySelector('address, .byline, [class*="byline" i], [rel="author"]');
      if (byline) {
        let scope: Element | null = byline;
        for (let i = 0; i < 4 && scope?.parentElement; i++) scope = scope.parentElement;
        out.bylineHtml = scope?.outerHTML.slice(0, 2500);
      }
      // Article main element (where Breitbart puts content)
      const article = document.querySelector('article, main, .entry-content, .article-content');
      out.articleTag = article?.tagName.toLowerCase();
      out.articleClass = article?.className.toString().slice(0, 100);
      // Embedded tweets
      const twitterBlockquotes = Array.from(document.querySelectorAll('blockquote.twitter-tweet'));
      out.twitterBlockquoteCount = twitterBlockquotes.length;
      if (twitterBlockquotes.length > 0) out.twitterBlockquoteSample = twitterBlockquotes[0].outerHTML.slice(0, 1000);
      const twitterIframes = Array.from(document.querySelectorAll('iframe[src*="twitter"], iframe[src*="platform.twitter"], iframe[id^="twitter-widget"]'));
      out.twitterIframeCount = twitterIframes.length;
      // Embedded videos / iframes (YouTube, Rumble, etc.)
      const videoIframes = Array.from(document.querySelectorAll('iframe[src*="youtube"], iframe[src*="rumble"], iframe[src*="vimeo"], iframe[src*="bitchute"], iframe[src*="odysee"]'));
      out.videoIframeCount = videoIframes.length;
      if (videoIframes.length > 0) {
        out.videoIframeSamples = videoIframes.slice(0, 3).map(f => ({
          src: f.getAttribute('src') ?? '',
          tag: f.tagName.toLowerCase(),
          class: f.className.toString().slice(0, 80),
        }));
      }
      // Native video tags
      const nativeVideos = Array.from(document.querySelectorAll('video'));
      out.nativeVideoCount = nativeVideos.length;
      if (nativeVideos.length > 0) {
        out.nativeVideoSamples = nativeVideos.slice(0, 3).map(v => ({
          poster: v.getAttribute('poster') ?? '',
          src: v.getAttribute('src') ?? v.querySelector('source')?.getAttribute('src') ?? '',
          parentHtml: v.parentElement?.outerHTML.slice(0, 400) ?? '',
        }));
      }
      // Any iframe at all (for visibility)
      const allIframes = Array.from(document.querySelectorAll('iframe'));
      out.totalIframes = allIframes.length;
      out.iframeSrcs = allIframes.slice(0, 12).map(f => (f.getAttribute('src') ?? '').slice(0, 100));
      return out;
    });

    writeFileSync(out('bb-dump.json'), JSON.stringify(dump, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(dump, null, 2));

    // Probe why <article> looks like a container
    const articleAnalysis = await page.evaluate(() => {
      const a = document.querySelector('article');
      if (!a) return { reason: 'no article' };
      return {
        nestedArticles: a.querySelectorAll('article').length,
        navs: a.querySelectorAll('nav').length,
        directHeaders: a.querySelectorAll(':scope > header').length,
        directFooters: a.querySelectorAll(':scope > footer').length,
        directSections: Array.from(a.children).filter(c => c.tagName.toLowerCase() === 'section').length,
        articleText: (a.textContent ?? '').replace(/\s+/g,' ').trim().slice(0, 200),
        articleHtmlPreview: a.outerHTML.slice(0, 1200),
      };
    });
    // eslint-disable-next-line no-console
    console.log('\n[article analysis]', JSON.stringify(articleAnalysis, null, 2));

    // Find any Rumble-related elements in the page (script tags, divs with
    // data-rumble, embed URLs in code).
    const rumbleMarkup = await page.evaluate(() => {
      const out: Record<string, unknown> = {};
      // Look for divs with class or data attribute mentioning rumble.
      const rumbleDivs = Array.from(document.querySelectorAll('[class*="rumble" i], [data-video], [data-rumble]'));
      out.rumbleDivCount = rumbleDivs.length;
      if (rumbleDivs.length > 0) out.rumbleDivSample = rumbleDivs[0].outerHTML.slice(0, 500);
      // Look for iframes whose src contains rumble or rumbl
      const rumbleIframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
        const s = (f.getAttribute('src') ?? '').toLowerCase();
        return s.includes('rumble') || s.includes('rmbl');
      });
      out.rumbleIframeCount = rumbleIframes.length;
      out.rumbleIframeContext = rumbleIframes.slice(0, 3).map(f => ({
        src: f.getAttribute('src'),
        parent: f.parentElement?.outerHTML.slice(0, 500),
        grandparent: f.parentElement?.parentElement?.outerHTML.slice(0, 400),
      }));
      // Also check for any video embed URLs in script bodies (Rumble loaders
      // often inject scripts with data-video-id).
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent ?? '').join('\n');
      const rumbleMatches = scripts.match(/rumble\.com\/embed\/[a-zA-Z0-9_-]+/g) ?? [];
      out.rumbleEmbedUrls = Array.from(new Set(rumbleMatches));
      return out;
    });
    writeFileSync(out('bb-rumble.json'), JSON.stringify(rumbleMarkup, null, 2), 'utf8');

    // Inspect inside the Breitbart tweet wrapper iframe: does it contain a
    // platform.twitter.com nested iframe? Or render the tweet inline itself?
    const bbTweetFrames = page.frames().filter(f => /\/t\/assets\/html\/tweet-/.test(f.url()));
    // eslint-disable-next-line no-console
    console.log(`\nBreitbart tweet wrapper frames: ${bbTweetFrames.length}`);
    for (let i = 0; i < bbTweetFrames.length; i++) {
      const f = bbTweetFrames[i];
      try {
        const inner = await f.evaluate(() => {
          const ptw = Array.from(document.querySelectorAll('iframe[src*="platform.twitter.com"], iframe[id^="twitter-widget"]'));
          const ptwSrcs = ptw.map(el => (el as HTMLIFrameElement).src);
          const blockquotes = Array.from(document.querySelectorAll('blockquote.twitter-tweet'));
          const article = document.querySelector('article');
          return {
            url: window.location.href,
            childIframeCount: document.querySelectorAll('iframe').length,
            ptwIframeCount: ptw.length,
            ptwIframeSrcs: ptwSrcs,
            blockquoteCount: blockquotes.length,
            blockquoteSample: blockquotes[0]?.outerHTML.slice(0, 400),
            articleTextSample: article?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200),
            bodyTextSample: document.body.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300),
          };
        });
        // eslint-disable-next-line no-console
        console.log(`Frame[${i}]`, JSON.stringify(inner, null, 2));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`Frame[${i}] error:`, e);
      }
    }
  } finally {
    await ctx.close();
  }
});
