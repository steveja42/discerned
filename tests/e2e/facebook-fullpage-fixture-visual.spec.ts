// Pixel baseline for a Facebook post captured in FULL-PAGE format.
//
// Why this exists as its own spec: the clip format is STICKY
// (STORAGE_KEYS.LAST_FORMAT persists the user's last choice), and each format
// has its own extractor. extractFacebookPost was originally wired only into
// extractArticle, so a user who had once picked "full-page" kept getting the
// old tagger path — wrong author on a tagged post, obfuscation garbage in the
// caption, no avatar — while every existing test, which drives 'article',
// stayed green. Twitter had already solved this by routing full-page through
// its Tier 0; Facebook now does the same, and this spec is what keeps it that
// way.
//
// Run: FB_FULL=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=facebook-fullpage-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('facebook-fullpage-fixture-visual', async () => {
  test.skip(!process.env.FB_FULL, 'set FB_FULL=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    // Distinct slug (fixtureFile points at the shared feed snapshot) so the
    // test-output artifacts don't overwrite the article spec's.
    site: 'facebook-fullpage',
    fixtureFile: 'facebook-feed.html',
    hostOverride: 'www.facebook.com',
    format: 'full-page',
    viewportHeight: 1400,
    // Same built card as the article path — a full-page capture of a post
    // must not fall back to the SPA shell.
    expectMarker: '.tweet-card .tweet-name',
  });
});
