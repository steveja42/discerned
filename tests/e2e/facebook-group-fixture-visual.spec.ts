// Pixel baseline for a GROUP post in the feed
// (tests/fixtures/sites/facebook-group.html).
//
// Why this shape needs its own guard: in a group, EVERY byline link is
// group-scoped — `/groups/<id>/user/<id>/` for the member and `/groups/<id>/`
// for the group — and neither matched fbIsProfileHref's vanity-slug or
// /profile.php patterns. fbBylineAnchors therefore returned ZERO, the card
// climb never terminated, and capture fell back to the bare message block:
// text only, with no avatar, no photo grid and no reactions. One rejected URL
// shape cost all four.
//
// The byline also differs here: `data-ad-rendering-role="profile_name"` holds
// the GROUP, while the member who posted sits in a separate sibling block, so
// the card renders "<group> · <member>" rather than crediting either alone.
//
// Run: FB_GROUP=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=facebook-group-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('facebook-group-fixture-visual', async () => {
  test.skip(!process.env.FB_GROUP, 'set FB_GROUP=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'facebook-group',
    hostOverride: 'www.facebook.com',
    viewportHeight: 1400,
    // A built card, not the bare message block the group-href defect produced.
    expectMarker: '.tweet-card .tweet-name',
  });
});
