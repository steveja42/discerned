// Pixel baseline for the Bluesky thread fixture
// (tests/fixtures/sites/bsky-thread.html). Uses hostOverride to activate
// tagBsky against the offline fixture so the baseline exercises the real
// per-site tagger (44px avatar pin, dx-header, dx-stats).
//
// Run with: BSKY_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bsky-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('bsky-thread-fixture-visual', async () => {
  test.skip(!process.env.BSKY_FIX, 'set BSKY_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'bsky-thread',
    hostOverride: 'bsky.app',
    viewportHeight: 1400,
  });
});
