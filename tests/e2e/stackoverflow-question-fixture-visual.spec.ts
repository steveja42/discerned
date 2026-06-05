// Pixel baseline for a HAND-CRAFTED StackOverflow question fixture
// (tests/fixtures/sites/stackoverflow-question.html). Real SO live snapshots
// hit Cloudflare's IP-block (not solvable Turnstile, hard deny). The fixture
// mimics SO's #mainbar / #question / .answer / .user-info / .post-menu shape
// so tagStackOverflow fires via hostOverride and we still validate the
// tagger's class-stamping + sanitiser behaviour.
//
// Run with: SO_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=stackoverflow-question-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('stackoverflow-question-fixture-visual', async () => {
  test.skip(!process.env.SO_FIX, 'set SO_FIX=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'stackoverflow-question',
    hostOverride: 'stackoverflow.com',
    viewportHeight: 1400,
  });
});
