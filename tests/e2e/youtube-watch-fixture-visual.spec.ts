// Pixel baseline for a real YouTube watch-page snapshot
// (tests/fixtures/sites/youtube-watch.html). Uses hostOverride to activate
// tagYoutube + postCloneYoutube against the offline fixture.
//
// Run with: YT_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=youtube-watch-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('youtube-watch-fixture-visual', async () => {
  test.skip(!process.env.YT_FIX, 'set YT_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'youtube-watch',
    hostOverride: 'www.youtube.com',
    viewportHeight: 1600,
    // Big YT snapshot inlines many channel/thumbnail images — element-level
    // stability check can't pin total clip height precisely. Use viewport
    // page clip for the above-the-fold region.
    pageClipScreenshot: true,
    // YT thumbnail/avatar lazy-decoding shifts pixels run-to-run beyond
    // the default 0.02 tolerance. 0.15 still catches structural breaks
    // (missing avatar, wrong layout) while ignoring image-decoding noise.
    maxDiffPixelRatio: 0.15,
  });
});
