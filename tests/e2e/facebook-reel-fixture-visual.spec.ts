// Pixel baseline for a real Facebook reel permalink
// (tests/fixtures/sites/facebook-reel.html). Uses hostOverride to activate
// extractFacebookPost's Tier-0 gate against the offline fixture.
//
// Regenerate the fixture with:
//   FBPOSTSNAP=1 FB_POST_URL=<reel URL> FB_SLUG=facebook-reel \
//     pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=snapshot-facebook-post
//
// Run: FB_REEL=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=facebook-reel-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('facebook-reel-fixture-visual', async () => {
  test.skip(!process.env.FB_REEL, 'set FB_REEL=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'facebook-reel',
    hostOverride: 'www.facebook.com',
    pathOverride: '/reel/4460125307635536',
    viewportHeight: 1400,
    // The defect this spec exists for was a missing image — a reel's blob:
    // video produces no frame-grab, and the og:image fallback never fires
    // because the old tagger path filled the clip with a thumbnail stack.
    // Require a real poster/video card in the clip.
    expectMarker: '.tweet-video-poster, .dx-video-link',
  });
});
