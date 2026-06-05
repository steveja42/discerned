// Pixel baseline for the Primal thread fixture
// (tests/fixtures/sites/primal-thread.html). Uses hostOverride to activate
// tagPrimal against the offline fixture so the baseline exercises the
// real per-site tagger (avatar pins, dx-header, dx-quote cards, dx-stats).
//
// Run with: PRIM_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=primal-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('primal-thread-fixture-visual', async () => {
  test.skip(!process.env.PRIM_FIX, 'set PRIM_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'primal-thread',
    hostOverride: 'primal.net',
    viewportHeight: 1600,
  });
});
