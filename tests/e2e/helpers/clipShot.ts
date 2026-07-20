// Screenshot a rendered .clip-body reliably. Chromium's compositor can only
// rasterize ~16,384px in one pass — element.screenshot on a taller element
// yields the first ~8k px followed by blank space and tile-duplicated copies
// of the top (seen on wikipedia/stackoverflow clips). For tall clips we
// instead take a viewport-clipped page screenshot of the element's top
// `maxHeight` px; structural assertions (clipBodyHealth) cover what's below.

import type { Locator, Page } from '@playwright/test';

// Full-page screenshot of a LIVE SOURCE site, tall-safe like screenshotClipBody so
// the source image is comparable to the clip/cast in the review gallery (same
// ~8000px cap, not just the 720px viewport). Chromium's fullPage capture hits the
// same ~16,384px raster limit, so past `maxHeight` we take a top-clipped page
// screenshot instead. Scrolls the page first to trigger lazy content, then back to
// top so the capture starts at the header.
export async function screenshotSourcePage(
  page: Page,
  path: string,
  maxHeight = 8000,
): Promise<void> {
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  if (pageHeight <= maxHeight) {
    await page.screenshot({ path, fullPage: true });
    return;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1280, height: Math.min(maxHeight, 8000) });
  await page.waitForTimeout(300);
  await page.screenshot({
    path,
    clip: { x: 0, y: 0, width: 1280, height: maxHeight },
  });
}

export async function screenshotClipBody(
  page: Page,
  clipBody: Locator,
  path: string,
  maxHeight = 8000,
): Promise<void> {
  let rect = await clipBody.boundingBox();
  if (!rect) {
    await clipBody.screenshot({ path });
    return;
  }
  const viewH = Math.min(Math.ceil(rect.height), maxHeight) + 100;
  await page.setViewportSize({ width: 1280, height: viewH });
  await page.waitForTimeout(500);
  rect = (await clipBody.boundingBox()) ?? rect;

  if (rect.height <= maxHeight) {
    await clipBody.screenshot({ path });
    return;
  }
  await clipBody.scrollIntoViewIfNeeded();
  rect = (await clipBody.boundingBox()) ?? rect;
  await page.screenshot({
    path,
    clip: {
      x: Math.max(rect.x, 0),
      y: Math.max(rect.y, 0),
      width: rect.width,
      height: maxHeight,
    },
  });
}
