// Pixel baseline for the GitHub README fixture
// (tests/fixtures/sites/github-readme.html). Guards code-block + heading layout.
//
// Run with: GH_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=github-readme-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('github-readme-fixture-visual', async () => {
  test.skip(!process.env.GH_FIX, 'set GH_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'github-readme' });
});
