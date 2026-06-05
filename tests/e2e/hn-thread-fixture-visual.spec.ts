// Pixel baseline for the Hacker News thread fixture
// (tests/fixtures/sites/hn-thread.html). Guards generic article pipeline.
//
// Run with: HN_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=hn-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('hn-thread-fixture-visual', async () => {
  test.skip(!process.env.HN_FIX, 'set HN_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'hn-thread', fixtureFile: 'hn-thread.html' });
});
