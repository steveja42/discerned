import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const CODE = process.env.IG_CODE ?? 'DcjUnx1j6tQ';

test('ig-og-probe: og:image + canonical across URL shapes', async () => {
  test.skip(!process.env.IGOG, 'set IGOG=1');
  test.setTimeout(300_000);
  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: false,
  });
  const report: string[] = [];
  const shapes = [
    `https://www.instagram.com/reel/${CODE}/`,
    `https://www.instagram.com/reels/${CODE}/`,
    `https://www.instagram.com/p/${CODE}/`,
  ];
  for (const url of shapes) {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(7_000);
      const info = await page.evaluate(() => {
        const meta = (p: string) =>
          document.querySelector<HTMLMetaElement>(`meta[property="${p}"], meta[name="${p}"]`)?.content ?? null;
        const vids = Array.from(document.querySelectorAll('video')).map(v => ({
          w: Math.round(v.getBoundingClientRect().width),
          h: Math.round(v.getBoundingClientRect().height),
          poster: (v as HTMLVideoElement).poster || null,
        }));
        // Any real content image (not avatar-sized) on cdninstagram?
        const imgs = Array.from(document.querySelectorAll('img'))
          .map(i => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight }))
          .filter(i => /cdninstagram|fbcdn/.test(i.src) && i.w >= 150 && i.h >= 150)
          .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 3);
        return {
          finalUrl: location.href, title: document.title,
          ogImage: meta('og:image'), ogTitle: meta('og:title'),
          ogVideo: meta('og:video'), canonical:
            document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
          videoCount: vids.length, videos: vids.slice(0, 3), bigImgs: imgs,
        };
      });
      report.push(`\n=== ${url} ===\n${JSON.stringify(info, null, 2)}`);
    } catch (e) {
      report.push(`\n=== ${url} ===\nFAILED: ${(e as Error).message.split('\n')[0]}`);
    } finally { await page.close().catch(() => undefined); }
  }
  await ctx.close();
  const out = report.join('\n');
  writeFileSync(resolve(OUT, 'ig-og-probe.txt'), out, 'utf8');
  console.log(out);
});
