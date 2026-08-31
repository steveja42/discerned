// Pixel baseline for a SHARED post
// (tests/fixtures/sites/facebook-share.html — a real /posts/ permalink where
// Bonnie Bowyer shared a post from Learn Laugh Teach).
//
// The reported defect: a shared post "doesn't look like a shared post, it
// looks like the post they shared" — the sharer's name and avatar were
// missing and the ORIGINAL poster's were shown in their place.
//
// Two things make this shape hard, both measured on this fixture:
//
//  1. The sharer often adds NO comment, so the only story_message on the card
//     belongs to the SHARED post. Treating the outermost message as "the
//     sharer's comment" therefore built the entire card out of the shared
//     content. The reliable signal is the screen-reader label,
//     "Shared post from <name>".
//  2. Document order does not separate the two posts. The shared card's
//     like/comment/share buttons come BEFORE the sharer's (measured at
//     offsets 550948 vs 653885), so a plain querySelector reports the
//     original's engagement as the sharer's.
//
// Run: FB_SHARE=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=facebook-share-fixture-visual

import { test } from '@playwright/test';
import { runFixtureVisual } from './helpers/fixtureVisual';

test.describe.configure({ mode: 'serial' });

test('facebook-share-fixture-visual', async () => {
  test.skip(!process.env.FB_SHARE, 'set FB_SHARE=1 to run');
  test.setTimeout(120_000);
  await runFixtureVisual({
    site: 'facebook-share',
    hostOverride: 'www.facebook.com',
    pathOverride: '/whealy/posts/pfbid02AvpREH7YmsxwdkFfD5559Jrnh55zonKYbJoDiqikUPAbtHG91Rww1pYqR2eFLvYal',
    viewportHeight: 1400,
    // The shared original must render as its own quote card — its absence is
    // what made a share look like a plain post.
    expectMarker: '.tweet-quote',
  });
});
