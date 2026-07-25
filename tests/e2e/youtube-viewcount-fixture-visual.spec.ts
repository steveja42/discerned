// Pixel baseline for the compact YouTube view-count fixture
// (tests/fixtures/sites/youtube-viewcount.html). This fixture — unlike the full
// youtube-watch.html snapshot, whose dynamic view-count / like widgets are
// empty — carries a POPULATED <yt-animated-rolling-number> odometer, so it
// reproduces the P2 corpus defect (view/like counts render one-digit-per-line
// + oversized like/subscribe glyphs). Runs the REAL tagYoutube + postCloneYoutube
// via hostOverride and guards that:
//   - the view count renders as a clean "399,124,001 views · 17 years ago"
//     dx-stats row (odometer replaced, no digit-stacking), and
//   - the like / subscribe / share / download SVG glyphs are gone.
//
// Run with: YT_VC=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=youtube-viewcount-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('youtube-viewcount-fixture-visual', async () => {
  test.skip(!process.env.YT_VC, 'set YT_VC=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'youtube-viewcount',
    fixtureFile: 'youtube-viewcount.html',
    hostOverride: 'www.youtube.com',
    viewportHeight: 900,
    expectMarker: '.dx-stats',
  });
});
