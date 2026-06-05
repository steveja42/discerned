// Pixel baseline for the tweet-with-show-more fixture
// (tests/fixtures/sites/tweet-with-show-more.html). Guards the "Show more"
// anchor preservation + nbsp separator handling on embedded tweet cards.
//
// Run with: SHOW_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=tweet-with-show-more-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('tweet-with-show-more-fixture-visual', async () => {
  test.skip(!process.env.SHOW_FIX, 'set SHOW_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'tweet-with-show-more' });
});
