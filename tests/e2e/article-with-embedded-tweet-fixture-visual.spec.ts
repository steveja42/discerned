// Pixel baseline for the article-with-embedded-tweet fixture
// (tests/fixtures/sites/article-with-embedded-tweet.html). Guards the
// blockquote-fallback embedded-tweet substitution path that doesn't need
// iframe scripting.
//
// Run with: EMB_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=article-with-embedded-tweet-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('article-with-embedded-tweet-fixture-visual', async () => {
  test.skip(!process.env.EMB_FIX, 'set EMB_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'article-with-embedded-tweet' });
});
