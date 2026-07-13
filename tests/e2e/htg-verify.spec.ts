import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';

test.skip(!process.env.HTGV, 'set HTGV=1');
test.setTimeout(60_000);

test('htg gallery cast images present + main-res', async () => {
  const { ctx } = await launchWithExtension({ headed: false });
  try {
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:4173/htg-gallery.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    const cap = (await page.evaluate(async () => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 30_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); window.removeEventListener('message', on);
        e.data.error ? rej(new Error(e.data.error)) : res(e.data.capture);
      };
      window.addEventListener('message', on);
      window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
    }))) as Record<string, unknown>;

    const body = (cap.bodyHtml as string) ?? '';
    const dxSrcs = [...body.matchAll(/data-dx-src="([^"]+)"/g)].map((m) => m[1]);
    const urls = (cap.imageUrls as string[]) ?? [];
    console.log('bodyHtml data-dx-src:', dxSrcs.length, dxSrcs.map((u) => u.match(/w=\d+/)?.[0]).join(','));
    console.log('imageUrls:', urls.length, urls.map((u) => u.match(/w=\d+/)?.[0]).join(','));
    // Cast (long-form markdown) images come from bodyHtml data-dx-src → ![](url).
    // Expect all 5 gallery photos present, at MAIN resolution (w=750), no thumbs.
    expect(dxSrcs.filter((u) => u.includes('w=750')).length).toBe(5);
    expect(dxSrcs.some((u) => u.includes('w=167') || u.includes('w=1920'))).toBe(false);
    expect(urls.length).toBe(5);
    expect(urls.every((u) => u.includes('w=750'))).toBe(true);
    console.log('OK: 5 main-res gallery images in both bodyHtml and imageUrls');
  } finally { await ctx.close(); }
});
