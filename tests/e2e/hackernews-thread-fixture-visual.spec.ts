// Pixel baseline for the Hacker News thread fixture
// (tests/fixtures/sites/hackernews-thread.html). Runs the REAL tagHackerNews
// tagger via hostOverride against the saved table-soup snapshot, so this guards
// the tagger + its dx-* layout (post header, dx-stats meta row, threaded
// dx-post/dx-reply comments with dx-byline) — not just the generic pipeline.
//
// Run with: HN_TAG=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=hackernews-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('hackernews-thread-fixture-visual', async () => {
  test.skip(!process.env.HN_TAG, 'set HN_TAG=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'hackernews-thread',
    fixtureFile: 'hackernews-thread.html',
    hostOverride: 'news.ycombinator.com',
    // The comment bodies are the load-bearing content — assert one rendered.
    expectMarker: '.dx-post',
  });
});
