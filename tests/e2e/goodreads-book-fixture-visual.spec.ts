// Pixel baseline for a real Goodreads book-page snapshot
// (tests/fixtures/sites/goodreads-book.html). Uses hostOverride to activate
// tagGoodreads against the offline fixture.
//
// Run with: GR_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=goodreads-book-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('goodreads-book-fixture-visual', async () => {
  test.skip(!process.env.GR_FIX, 'set GR_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'goodreads-book',
    hostOverride: 'www.goodreads.com',
    viewportHeight: 1400,
    // Goodreads BookPage clip is ~74 inlined images tall — element-level
    // toHaveScreenshot can't stabilize. Viewport-clipped page screenshot
    // captures just the above-the-fold region, which is what the user sees
    // first anyway.
    pageClipScreenshot: true,
  });
});
