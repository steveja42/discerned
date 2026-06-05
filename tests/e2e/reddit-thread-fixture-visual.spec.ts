// Pixel baseline for a real Reddit thread snapshot
// (tests/fixtures/sites/reddit-thread.html). Uses hostOverride to activate
// tagReddit + postCloneReddit against the offline fixture.
//
// Run with: REDDIT_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=reddit-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('reddit-thread-fixture-visual', async () => {
  test.skip(!process.env.REDDIT_FIX, 'set REDDIT_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'reddit-thread',
    hostOverride: 'www.reddit.com',
    viewportHeight: 1600,
  });
});
