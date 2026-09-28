// markExcluded's product-page rules, which need real layout (jsdom has none):
// a sticky column holding the page's h1 is content (target's title/price panel),
// a clipped gallery keeps only its in-frame slide, a priced shelf on a product
// page is cross-sell and goes whole, and any other shelf keeps what was on screen.

import { test, expect, type BrowserContext } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';

async function capture(ctx: BrowserContext, name: string): Promise<string> {
  const url = `http://127.0.0.1:4173/${name}.html`;
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await activateExtensionOnTab(ctx, url);
  const cap = await page.evaluate(() => new Promise<{ bodyHtml?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture timeout')), 15_000);
    const on = (e: MessageEvent) => {
      if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
      clearTimeout(timer); removeEventListener('message', on);
      resolve(e.data.capture ?? {});
    };
    addEventListener('message', on);
    postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
  }));
  await page.close();
  return cap.bodyHtml ?? '';
}

test('product page: sticky title column kept, gallery and shelves trimmed', async () => {
  test.setTimeout(60_000);
  const { ctx } = await launchWithExtension();
  try {
    const html = await capture(ctx, 'commerce-pdp');
    expect(html, 'sticky column holding the h1').toContain('Trailhead Canvas Backpack 30L');
    expect(html, 'price in the sticky column').toContain('$89.00');
    expect(html).toContain('Waxed canvas that sheds rain');

    expect(html, 'in-frame slide of a sticky gallery').toContain('Backpack 30L front');
    expect(html, 'off-frame gallery slides').not.toMatch(/Backpack 30L (side|open|straps)/);

    expect(html, 'priced shelf removed with its heading').not.toContain('Shoppers also picked');
    expect(html).not.toContain('Rail pick');

    expect(html, 'unpriced shelf keeps its heading').toContain('Trail photos');
    expect(html, 'in-frame photo').toContain('Trail photo 1');
    expect(html, 'off-frame photo').not.toContain('Trail photo 8');

    expect(html, 'a sideways-scrolling table is content').toContain('SPEC-FAR-COLUMN');
  } finally {
    await ctx.close();
  }
});

test('article: a priced shelf is only trimmed, and a sticky ad rail still goes', async () => {
  test.setTimeout(60_000);
  const { ctx } = await launchWithExtension();
  try {
    const html = await capture(ctx, 'commerce-shop-article');
    expect(html).toContain('The best way to pack for a week on the trail');
    expect(html, 'shelf kept on a non-product page').toContain('Shop the gear');
    expect(html).toContain('Shop pick 1');
    expect(html, 'off-frame card').not.toContain('Shop pick 8');
    expect(html, 'sticky rail without the headline').not.toContain('STICKY-SHARE-RAIL');
    expect(html, 'a big sticky image not named like the page').not.toContain('Summer sale on tents');
  } finally {
    await ctx.close();
  }
});
