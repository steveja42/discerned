// Pixel baseline for the Slashdot story fixture (tests/fixtures/sites/slashdot-story.html,
// trimmed to the story + its first two comment threads). The thread sits OUTSIDE
// the story's <article>, so without tagSlashdot the clip was the story alone.
// Runs the REAL tagSlashdot + postCloneSlashdot via hostOverride.
//
// Run with: SLASHDOT=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=slashdot-story-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('slashdot-story-fixture-visual', async () => {
  test.skip(!process.env.SLASHDOT, 'set SLASHDOT=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'slashdot-story',
    hostOverride: 'hardware.slashdot.org',
    expectMarker: '.dx-reply .dx-byline',
    fitViewportToClip: true,
  });
});
