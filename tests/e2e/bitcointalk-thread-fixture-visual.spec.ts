// Pixel baseline for the bitcointalk.org (SMF forum) thread fixture
// (tests/fixtures/sites/bitcointalk-thread.html). Runs the REAL tagBitcointalk
// tagger via hostOverride against the saved table-soup snapshot, so this guards
// the tagger + its dx-* layout — specifically the two defects it exists to fix:
// the flattened `td.poster_info` author panel collapsing into a narrow vertical
// column, and the per-post `div.signature` ad footers duplicating into the cast.
//
// Run with: BCT=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bitcointalk-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('bitcointalk-thread-fixture-visual', async () => {
  test.skip(!process.env.BCT, 'set BCT=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'bitcointalk-thread',
    fixtureFile: 'bitcointalk-thread.html',
    hostOverride: 'bitcointalk.org',
    // The post bodies are the load-bearing content — assert one rendered.
    expectMarker: '.dx-post',
  });
});
