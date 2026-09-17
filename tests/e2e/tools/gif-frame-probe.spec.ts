// CAN a bsky GIF be turned into a real image? Three routes, measured.
//
// The earlier conclusion ("canvas grab throws SecurityError, so no") was drawn
// from Bluesky's OWN <video>, which sets no crossOrigin attribute — that taints
// the canvas regardless of what the server allows. But the CDN returns
// `Access-Control-Allow-Origin: *`, so a video WE create with
// crossOrigin="anonymous" should be grabbable with no extension permission at
// all. This tests that, plus the two fallbacks, and reports which work.
//
// Run: GIFF=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=gif-frame-probe

import { test } from '@playwright/test';
import { chromium } from '@playwright/test';

const MP4 = process.env.GIFF_URL
  ?? 'https://k.gifs.bsky.app/ii/c3a19a0b747a76e98651f2b9a3cca5ff/aa/d0/acCKtEYS53h8wB48A1.mp4';

test('gif-frame-probe', async () => {
  test.skip(!process.env.GIFF, 'set GIFF=1 to run');
  test.setTimeout(120_000);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // A page on an UNRELATED origin, to prove no same-origin luck is involved.
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async (src) => {
      const out: string[] = [];

      const tryGrab = (crossOrigin: string | null) => new Promise<string>((resolve) => {
        const v = document.createElement('video');
        if (crossOrigin) v.crossOrigin = crossOrigin;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = src;
        const done = (msg: string) => { resolve(msg); };
        const timer = setTimeout(() => done('TIMEOUT'), 20_000);
        v.onerror = () => { clearTimeout(timer); done(`LOAD ERROR ${v.error?.code ?? '?'}`); };
        v.onloadeddata = () => {
          // Seek a little in so we don't grab a black first frame.
          v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
        };
        v.onseeked = () => {
          clearTimeout(timer);
          try {
            const c = document.createElement('canvas');
            c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext('2d')!.drawImage(v, 0, 0);
            const uri = c.toDataURL('image/jpeg', 0.8);
            done(uri && uri !== 'data:,'
              ? `OK ${v.videoWidth}x${v.videoHeight} dataUri=${uri.length} chars`
              : 'EMPTY');
          } catch (e) {
            done(`THREW ${(e as Error).name}`);
          }
        };
      });

      out.push(`crossOrigin="anonymous": ${await tryGrab('anonymous')}`);
      out.push(`crossOrigin=none:        ${await tryGrab(null)}`);

      // Route 3: plain fetch → blob (needs CORS, no extension permission).
      try {
        const r = await fetch(src);
        const b = await r.blob();
        out.push(`fetch->blob:             OK ${b.size} bytes type=${b.type}`);
      } catch (e) {
        out.push(`fetch->blob:             THREW ${(e as Error).name}`);
      }
      return out.join('\n');
    }, MP4);

    // eslint-disable-next-line no-console
    console.log('\n' + result + '\n');
  } finally {
    await browser.close();
  }
});
