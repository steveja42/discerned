// Pixel baseline for the Wikipedia fixture (tests/fixtures/sites/wikipedia.html).
// Guards the generic article pipeline + shared CSS against regressions.
//
// Run with: WIKI_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=wikipedia-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('wikipedia-fixture-visual', async () => {
  test.skip(!process.env.WIKI_FIX, 'set WIKI_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'wikipedia' });
});
