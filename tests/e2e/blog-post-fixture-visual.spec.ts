// Pixel baseline for the generic blog-post fixture
// (tests/fixtures/sites/blog-post.html). Guards the Readability fallback path.
//
// Run with: BLOG_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=blog-post-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('blog-post-fixture-visual', async () => {
  test.skip(!process.env.BLOG_FIX, 'set BLOG_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({ site: 'blog-post' });
});
