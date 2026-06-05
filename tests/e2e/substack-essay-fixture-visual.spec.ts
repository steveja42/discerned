// Pixel baseline for the Substack-essay fixture
// (tests/fixtures/sites/substack-essay.html). Guards longform article layout.
//
// Run with: SUB_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=substack-essay-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('substack-essay-fixture-visual', async () => {
  test.skip(!process.env.SUB_FIX, 'set SUB_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'substack-essay', viewportHeight: 1400 });
});
