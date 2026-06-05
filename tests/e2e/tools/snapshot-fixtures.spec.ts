// One-shot tool: load real pages with the anti-detection profile, wait for
// site-specific tagger anchors to render, then save the fully-rendered HTML
// (including DOM mutated by SPA frameworks) to tests/fixtures/sites/.
//
// Run with: SNAP=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=snapshot-fixtures
//
// Re-run only when you need to refresh a fixture (after a site redesign
// breaks the saved selectors). Otherwise the saved snapshots are stable.

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launchWithExtension } from '../helpers/launchExtension';

const SITES = [
  {
    slug: 'reddit-thread',
    url: 'https://www.reddit.com/r/AskReddit/comments/1bp7ndj/whats_a_movie_thats_so_good_that_you_dont_want_to/',
    waitFor: 'shreddit-post',
    profile: 'test',
  },
  {
    slug: 'youtube-watch',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', // "Me at the zoo" (first YT video, evergreen)
    waitFor: 'ytd-watch-flexy, #above-the-fold, #title h1',
    profile: 'test',
  },
  {
    slug: 'goodreads-book',
    url: 'https://www.goodreads.com/book/show/4671.The_Great_Gatsby',
    waitFor: '[data-testid="bookTitle"], h1[data-testid="bookTitle"], h1.Text__title1',
    profile: 'test',
  },
  {
    slug: 'stackoverflow-question',
    // Different evergreen question — first was getting CF-blocked. Try one
    // with very high traffic so CF treats it like a normal pageview.
    url: 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
    waitFor: '#question, .answer',
    profile: 'test',
  },
];

const FIXTURE_DIR = resolve(__dirname, '..', '..', 'fixtures', 'sites');

for (const site of SITES) {
  test(`snapshot ${site.slug}`, async () => {
    test.skip(!process.env.SNAP, 'set SNAP=1 to refresh fixtures');
    test.setTimeout(180_000);

    const { ctx } = await launchWithExtension({ profile: site.profile, headed: !!process.env.PWDEBUG_HEADED });
    try {
      const page = await ctx.newPage();
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Generous timeout in headed mode so the user has time to click through
      // Cloudflare Turnstile interactively if it shows up.
      const waitTimeout = process.env.PWDEBUG_HEADED ? 120_000 : 30_000;
      try {
        await page.waitForSelector(site.waitFor, { timeout: waitTimeout });
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[snapshot] ${site.slug}: waitFor selector "${site.waitFor}" not found, saving anyway`);
      }
      // Let lazy content settle.
      await page.waitForTimeout(3000);

      // Pull the fully-rendered HTML.
      const html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
      const outPath = resolve(FIXTURE_DIR, `${site.slug}.html`);
      writeFileSync(outPath, html, 'utf8');
      // eslint-disable-next-line no-console
      console.log(`[snapshot] wrote ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);
    } finally {
      await ctx.close();
    }
  });
}
