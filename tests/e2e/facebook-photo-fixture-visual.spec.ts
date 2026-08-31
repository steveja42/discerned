// Pixel baseline for a real Facebook photo permalink
// (tests/fixtures/sites/facebook-photo.html). Uses hostOverride to activate
// extractFacebookPost's Tier-0 gate against the offline fixture.
//
// Regenerate the fixture with:
//   FBPOSTSNAP=1 FB_POST_URL=<photo URL> FB_SLUG=facebook-photo \
//     pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=snapshot-facebook-post
//
// Run: FB_PHOTO=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=facebook-photo-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('facebook-photo-fixture-visual', async () => {
  test.skip(!process.env.FB_PHOTO, 'set FB_PHOTO=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'facebook-photo',
    hostOverride: 'www.facebook.com',
    pathOverride: '/photo/?fbid=2915603832116944',
    viewportHeight: 1400,
    // The defect this spec exists for was a long thumbnail stack instead of a
    // single scoped card — the tagger-root EXCL_MARKER-clearing bug let every
    // preloaded carousel/next-item image survive. Require exactly the card
    // shape (a single tweet-photo cell), not the stack.
    expectMarker: '.tweet-photo',
  });
});
