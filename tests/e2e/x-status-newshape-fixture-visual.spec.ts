// Pixel baseline for the redesigned x.com status-page DOM
// (tests/fixtures/sites/x-status-newshape.html), captured from a real x.com
// tweet (https://x.com/CIA/status/2055074954375254084) mid-2026 after X
// dropped the [data-testid="..."] hooks Tier 0's extractTweet() relied on.
//
// Regression this guards: without new-shape fallback selectors, extractTweet
// returns null, the capture falls through to the generic layout finder, and
// the rendered clip puts the avatar/username beside the body and the
// date/view-count/stats beside it too, instead of a proper tweet-card header
// (avatar+name+handle on top) and footer (date/views/stats below the body).
//
// hostOverride: 'x.com' makes isTweetHost() treat the 127.0.0.1-served
// fixture as x.com so Tier 0 actually engages (Tier 0 gates on the real page
// URL, unlike SITE_TAGGERS which only need a hostname override).
//
// Run with: XNEW_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=x-status-newshape-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('x-status-newshape-fixture-visual', async () => {
  test.skip(!process.env.XNEW_FIX, 'set XNEW_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'x-status-newshape',
    hostOverride: 'x.com',
    expectMarker: '.tweet-card',
    viewportHeight: 900,
  });
});
