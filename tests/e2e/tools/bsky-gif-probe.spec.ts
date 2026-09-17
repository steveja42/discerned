// Bluesky GIF embeds: what element actually carries the animation?
//
// Reply "images" on bsky are often GIFs, and the census that counted <img>
// found none of them — the tell is a `<button aria-label="Pause GIF">`
// overlaying the media. Bluesky sources these from Tenor, and the animation is
// likely a <video> (Tenor serves mp4) rather than an <img>, so the capture
// pipeline's image paths never see it.
//
// Reports every Pause-GIF button on the page with its surrounding subtree: the
// media element type, its src/poster, the accessible label (which carries the
// alt text), and the wrapper chain — enough to decide what the tagger should
// emit for it.
//
// Run: BGIF=1 [BGIF_URL=<url>] pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bsky-gif-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.BGIF_URL
  ?? 'https://bsky.app/profile/tiredsleepyzzz.bsky.social/post/3mvpot4yxlc2o';

test('bsky-gif-probe', async () => {
  test.skip(!process.env.BGIF, 'set BGIF=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension(
      process.env.BGIF_PROFILE ? { profile: process.env.BGIF_PROFILE } : {});
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(7000);
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);

    const report = await page.evaluate(() => {
      const out: string[] = [];
      out.push(`URL: ${location.href}`);
      out.push(`<video> on page: ${document.querySelectorAll('video').length}`);
      out.push(`<img> on page: ${document.querySelectorAll('img').length}`);
      const gifBtns = Array.from(document.querySelectorAll('[aria-label*="GIF" i]'));
      out.push(`GIF buttons: ${gifBtns.length}`);

      gifBtns.forEach((btn, i) => {
        out.push(`\n=== GIF[${i}] aria-label="${btn.getAttribute('aria-label')}" ===`);
        // Climb to the container that holds the actual media.
        let scope: Element | null = btn.parentElement;
        for (let d = 0; d < 6 && scope; d++) {
          const v = scope.querySelector('video');
          const im = scope.querySelector('img');
          if (v || im) break;
          scope = scope.parentElement;
        }
        if (!scope) { out.push('  no media found within 6 levels'); return; }
        out.push(`  scope: <${scope.tagName.toLowerCase()}> testid=${scope.getAttribute('data-testid') ?? '-'}`);
        scope.querySelectorAll('video').forEach((v, j) => {
          const r = v.getBoundingClientRect();
          out.push(`  video[${j}] ${Math.round(r.width)}x${Math.round(r.height)}`);
          out.push(`    src="${(v.getAttribute('src') ?? 'none').slice(0, 90)}"`);
          out.push(`    poster="${(v.getAttribute('poster') ?? 'none').slice(0, 90)}"`);
          out.push(`    currentSrc="${(v.currentSrc ?? '').slice(0, 90)}"`);
          out.push(`    autoplay=${v.hasAttribute('autoplay')} loop=${v.hasAttribute('loop')} muted=${v.muted}`);
          Array.from(v.querySelectorAll('source')).forEach((s, k) => {
            out.push(`    source[${k}] type=${s.getAttribute('type') ?? '-'} src=${s.getAttribute('src') ?? ''}`);
          });
          out.push(`    aria-label="${v.getAttribute('aria-label') ?? '-'}" alt="${v.getAttribute('alt') ?? '-'}"`);
          // captureVideoFrames skips readyState < 2 or videoWidth === 0, so
          // these decide whether a canvas frame can be grabbed at all.
          out.push(`    readyState=${v.readyState} videoWidth=${v.videoWidth} videoHeight=${v.videoHeight} paused=${v.paused}`);
          // And whether a direct (same-origin) canvas grab is even permitted.
          let canvasResult = 'ok';
          try {
            const c = document.createElement('canvas');
            c.width = v.videoWidth || 2; c.height = v.videoHeight || 2;
            c.getContext('2d')?.drawImage(v, 0, 0);
            const uri = c.toDataURL('image/jpeg', 0.5);
            canvasResult = uri && uri !== 'data:,' ? `grabbed ${uri.length} chars` : 'empty';
          } catch (e) {
            canvasResult = `THREW ${(e as Error).name}`;
          }
          out.push(`    canvas grab: ${canvasResult}`);
        });
        scope.querySelectorAll('img').forEach((im, j) => {
          const r = im.getBoundingClientRect();
          out.push(`  img[${j}] ${Math.round(r.width)}x${Math.round(r.height)} alt="${im.getAttribute('alt') ?? '-'}"`);
          out.push(`    src="${(im.getAttribute('src') ?? '').slice(0, 90)}"`);
        });
        // The post this GIF belongs to.
        const post = btn.closest('[data-testid^="postThreadItem-by-"], [data-testid^="feedItem-by-"]');
        out.push(`  in post: ${post?.getAttribute('data-testid') ?? 'NONE'}`);
        const txt = (post?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
        out.push(`  post text: "${txt}"`);
      });

      // Any Tenor/media.tenor URL anywhere, in case the button climb missed one.
      const tenor = new Set<string>();
      document.querySelectorAll('video, img, source').forEach((el) => {
        const s = el.getAttribute('src') ?? '';
        if (/tenor|giphy/i.test(s)) tenor.add(s.slice(0, 90));
      });
      out.push(`\nTenor/Giphy URLs found: ${tenor.size}`);
      tenor.forEach(t => out.push(`  ${t}`));
      return out.join('\n');
    });

    const dir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'bsky-gif-probe.txt'), report, 'utf8');
    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    await ctx.close();
  }
});
