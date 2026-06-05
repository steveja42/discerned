// Pixel baseline for the generic news-article fixture
// (tests/fixtures/sites/news-article.html). Guards the generic
// `<article>` Tier 1 path + dx-byline detection + shared CSS.
//
// Run with: NEWS_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=news-article-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('news-article-fixture-visual', async () => {
  test.skip(!process.env.NEWS_FIX, 'set NEWS_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'news-article' });
});
