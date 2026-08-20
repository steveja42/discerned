// Pixel baseline for the phpBB thread fixture (tests/fixtures/sites/phpbb-thread.html).
// phpBB is the second-most-common forum engine after Discourse and ships stock,
// unhashed classes (postprofile / postbody / signature), so the same defects
// bitcointalk hit apply here: a narrow author side-column and repeated per-post
// signature blocks. Runs the REAL tagPhpBB tagger via hostOverride.
//
// Run with: PHPBB=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=phpbb-thread-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('phpbb-thread-fixture-visual', async () => {
  test.skip(!process.env.PHPBB, 'set PHPBB=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'phpbb-thread',
    fixtureFile: 'phpbb-thread.html',
    hostOverride: 'www.phpbb.com',
    expectMarker: '.dx-post',
  });
});
