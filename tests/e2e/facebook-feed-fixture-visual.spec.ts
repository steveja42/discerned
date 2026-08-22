// Pixel baseline for a real Facebook home-feed snapshot
// (tests/fixtures/sites/facebook-feed.html). Uses hostOverride to activate
// tagFacebook against the offline fixture.
//
// The live feed serves a different post shape on every load (plain / shared /
// tagged), which is why four live attempts at the byline fix each passed on one
// shape and failed on the next. This runs the real tagger against a frozen
// tree, so the result is deterministic and iterating costs seconds.
//
// Run: FB_FIX=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=facebook-feed-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('facebook-feed-fixture-visual', async () => {
  test.skip(!process.env.FB_FIX, 'set FB_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'facebook-feed',
    hostOverride: 'www.facebook.com',
    viewportHeight: 1600,
    // The clip must carry the post's own byline — the defect this spec exists
    // for was a header-less card (the byline selector matched zero elements on
    // a feed page, so the card climb never acquired an author).
    expectMarker: '.dx-author',
  });
});
