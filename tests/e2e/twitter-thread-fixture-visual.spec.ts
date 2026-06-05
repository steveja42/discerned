// Pixel baseline for the twitter-thread fixture
// (tests/fixtures/sites/twitter-thread.html). Validates Tier 0 extractTweet
// output rendered via tweet-card CSS. Note: site host check (twitter.com /
// x.com) fails on 127.0.0.1, so the generic pipeline + shared CSS handle the
// fixture instead of the Tier 0 extractor. Baseline documents that output.
//
// Run with: TWT_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=twitter-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('twitter-thread-fixture-visual', async () => {
  test.skip(!process.env.TWT_FIX, 'set TWT_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'twitter-thread' });
});
