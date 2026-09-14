// Pixel baseline for the AP News fixture (tests/fixtures/sites/apnews-article.html).
//
// Guards TWO generic regressions the 2026-09-11 corpus sweep caught on apnews
// and apnews-tech, where the story was captured intact but sat below ~4700px of
// chrome:
//   1. A leading <video> player + "More Videos" rail of UNRELATED clips.
//   2. A 6-slide photo carousel EXPANDED to all six slides (the inactive five
//      are position:absolute at left:100%..500%, hidden only by CSS the
//      sanitiser strips).
// The fixture also still covers the earlier Viafoura comment-widget defect.
//
// Run with: AP_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=apnews-article-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('apnews-article-fixture-visual', async () => {
  test.skip(!process.env.AP_FIX, 'set AP_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'apnews-article', hostOverride: 'apnews.com' });
});
