// Screenshot a rendered .clip-body reliably. Chromium's compositor can only
// rasterize ~16,384px in one pass — element.screenshot on a taller element
// yields the first ~8k px followed by blank space and tile-duplicated copies
// of the top (seen on wikipedia/stackoverflow clips). For tall clips we
// instead take a viewport-clipped page screenshot of the element's top
// `maxHeight` px; structural assertions (clipBodyHealth) cover what's below.

import type { Locator, Page } from '@playwright/test';

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
