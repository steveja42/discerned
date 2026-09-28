// Pixel baseline for the XenForo thread fixture (tests/fixtures/sites/xenforo-thread.html,
// an XDA Forums thread). XenForo is an ENGINE tagger like phpBB: tagXenForo matches
// <html id="XF"> rather than a hostname, so no hostOverride is needed. Guards the
// rebuilt author column ("name · title" over labelled Joined/Messages/Reaction
// score) and the dropped rails. The fixture's YouTube embeds were removed by the
// snapshot tool, since a poster would be fetched live.
//
// Run with: XENFORO=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=xenforo-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('xenforo-thread-fixture-visual', async () => {
  test.skip(!process.env.XENFORO, 'set XENFORO=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'xenforo-thread',
    expectMarker: '.dx-post .dx-byline',
    fitViewportToClip: true,
  });
});
