import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

test.skip(!process.env.HTGLIVE, 'set HTGLIVE=1');
test.setTimeout(180_000);

const URL = 'https://www.howtogeek.com/obd-ii-scanner-saved-unnecessary-mechanic-visits/';

test('htg LIVE page — dump rendered carousel DOM + capture', async () => {
  const { ctx } = await launchWithExtension({ profile: 'test' });
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // Scroll progressively so IntersectionObserver-driven galleries render.
    for (let y = 0; y < 3000; y += 400) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => window.scrollTo(0, 400));
    const galleryUp = await page
      .waitForSelector('img[alt*="P0302"]', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    console.log('gallery rendered:', galleryUp);

    mkdirSync('test-output', { recursive: true });

    if (galleryUp) {
      // Dump the LIVE carousel markup (walk up from the P0302 img to the
      // outermost wrapper that still contains all 5 gallery alts).
      const liveHtml = await page.evaluate(() => {
        let el: Element | null = document.querySelector('img[alt*="P0302"]');
        let best: Element | null = el;
        while (el && el !== document.body) {
          const alts = el.querySelectorAll('img[alt*="OBD-II"]').length;
          if (alts >= 5) { best = el; break; }
          el = el.parentElement;
        }
        return best ? best.outerHTML : '(not found)';
      });
      writeFileSync('test-output/htg-live-carousel.html', liveHtml, 'utf8');
      console.log(`live carousel dumped: ${liveHtml.length} chars`);
    }

    const cap = (await page.evaluate(async () => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('capture timeout')), 60_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); window.removeEventListener('message', on);
        e.data.error ? rej(new Error(e.data.error)) : res(e.data.capture);
      };
      window.addEventListener('message', on);
      window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
    }))) as Record<string, unknown>;

    const body = (cap.bodyHtml as string) ?? '';
    writeFileSync('test-output/htg-live-bodyHtml.html', body, 'utf8');
    const imgTags = body.match(/<img[^>]*>/gi) ?? [];
    console.log(`bodyHtml: ${imgTags.length} <img> tags`);
    imgTags.forEach((tag, i) => {
      const attr = (n: string) => tag.match(new RegExp(`${n}="([^"]*)"`, 'i'))?.[1] ?? '';
      console.log(`img[${i}] alt="${attr('alt').slice(0, 26)}" dx-src=${attr('data-dx-src').slice(48, 118) || '(none)'}`);
    });
    console.log('imageUrls:', ((cap.imageUrls as string[]) ?? []).map((u) => u.slice(48, 110)).join('\n  '));
  } finally { await ctx.close(); }
});
