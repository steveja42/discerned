// Visual harness for stacker.news item clips.
// Captures a real item page via the extension, renders it through the web app
// (/clips), and screenshots source / clip / cast for human review — the loop
// used to iterate on the tagStackerNews tagger.
//
// Run with: SN=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=stackernews-visual
//
// Stacker.news is server-rendered and unwalled, so unlike the CF-gated live
// specs this one needs no warm profile and runs headless.
//
// Both ClipFormats are asserted. 'article' is scoped by the tagger's returned
// <main>; 'full-page' ignores that root and clones the whole body, so the two
// reach the comment thread by different paths and a tagger change can fix one
// while leaving the other short. The comment-completeness check is the point
// of running both.

import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody, screenshotSourcePage } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';
import { liveArtifacts } from './helpers/liveArtifacts';
import { refreshLiveGallery } from './helpers/liveGallery';

const SN_URL = process.env.SN_URL || 'https://stacker.news/items/1573535';

// Every commenter on the default thread. Asserted by handle rather than by a
// count of .dx-reply so a failure names WHICH comments were lost — a count
// alone cannot distinguish "the tail was truncated" from "the tagger stopped
// marking replies", which are different bugs with different fixes.
const COMMENT_HANDLES = [
  '@Bitcoiner1', '@Kruw', '@DiedOnTitan', '@jasonb', '@0xbitcoiner',
  '@BlokchainB', '@cryotosensei', '@Chikasunbeats', '@Machiavelli23',
  '@guerratotal', '@mkmloom', '@LightOfBitcoin', '@elite',
];

async function assertItemClip(clipBody: Locator, label: string): Promise<void> {
  const text = (await clipBody.innerText()).replace(/\s+/g, ' ');

  // The defect this tagger exists for: the clip must carry the post HEADER —
  // title, author handle, and the sats/comments meta — not open straight into
  // the body. Stacker.news has no avatars and renders its timestamp as a plain
  // <a> carrying an ISO `title` (never a <time>), so the generic dx-byline
  // pass could not see this strip and the layout finder dropped it.
  expect(text, label).toContain('Bitcoinized business names');
  expect(text, label).toContain('@TotallyHumanWriter');
  expect(text, label).toMatch(/\d+ sats/);
  expect(await clipBody.locator('.dx-byline').count(), label).toBeGreaterThan(0);

  // The whole comment thread, by author: 24 comments from 13 distinct handles.
  const missing = COMMENT_HANDLES.filter((h) => !text.includes(h));
  expect(missing, `${label}: comments missing from the clip`).toEqual([]);
  expect(await clipBody.locator('.dx-reply').count(), label).toBeGreaterThanOrEqual(20);

  // Chrome that must NOT ride along. The related-items rail is server-rendered
  // as empty `clouds` skeletons and only appears once hydrated, so it is
  // invisible to any fixture built from raw HTML — it has to be checked live.
  expect(text, label).not.toContain('SN Saturday Newsletter');
  // The reply composer at the foot of the thread (a lexical editor whose
  // toolbar sanitises into a run of bare verbs and ~10 stray glyphs).
  expect(text, label).not.toMatch(/\bcompose\b/);
  expect(text, label).not.toMatch(/pull down to refresh/);
  // The comment-sort control between the body and the first comment
  // ("1132 sats | lit | new | top"). It is a <nav>, but a tagger-returned root
  // discards the landmark stripper's EXCL_MARKERs, so it has to be excluded by
  // class — and it reads as four stray one-word lines in the CAST, where no
  // CSS makes it look like a control.
  expect(text, label).not.toMatch(/\blit new top\b/i);
}

test.describe.configure({ mode: 'serial' });

test('stackernews: capture clip, render in web app, screenshot card', async () => {
  test.skip(!process.env.SN, 'set SN=1 to run this');
  test.setTimeout(240_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });
  const live = liveArtifacts('stackernews');

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Discerned')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, msg.text());
      }
    });
    await page.goto(SN_URL, { waitUntil: 'load', timeout: 60_000 });
    // The related-items rail hydrates after load; the tagger keys off its
    // hydrated wrapper (item_grid__) to exclude it.
    await page.waitForTimeout(3_000);
    await screenshotSourcePage(page, live.source());

    await activateExtensionOnTab(ctx, SN_URL);

    const capture = async (format: 'article' | 'full-page') =>
      (await page.evaluate(async (fmt) => {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('capture timeout')), 40_000);
          const onMessage = (e: MessageEvent) => {
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            if (e.data.error) rej(new Error(e.data.error));
            else res(e.data.capture);
          };
          window.addEventListener('message', onMessage);
          window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: fmt }, window.location.origin);
        });
      }, format)) as Record<string, unknown>;

    const render = async (cap: Record<string, unknown>) => {
      const libPage = await ctx.newPage();
      await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
      await libPage.evaluate((c) => {
        const clip = { capture: c, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
        const pubkey = new Array(64).fill('a').join('');
        window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey, authMethod: 'nip07' }, window.location.origin);
        window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
      }, cap);
      const row = libPage.locator('article.clip').first();
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await row.click();
      const clipBody = libPage.locator('.clip-body');
      await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
      await libPage.waitForTimeout(1000);
      return { libPage, clipBody };
    };

    // --- article: the primary path, and where the screenshots come from.
    const cap = await capture('article');
    const { libPage, clipBody } = await render(cap);

    await screenshotClipBody(libPage, clipBody, live.clip());
    const bodyBox = await clipBody.boundingBox();
    if (bodyBox) {
      // Tight crop of the header + lead, where the byline defect lived.
      await libPage.screenshot({
        path: live.clip('top'),
        clip: {
          x: bodyBox.x, y: bodyBox.y,
          width: Math.min(bodyBox.width, 700),
          height: Math.min(bodyBox.height, 1400),
        },
      });
    }
    await castShotSafe(page, cap as { title?: string }, live.cast());

    await assertItemClip(clipBody, 'article');
    await assertClipBodyHealth(clipBody);

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    fs.writeFileSync(resolve(outDir, 'stackernews-rendered.html'), html, 'utf8');
    await libPage.close();

    // --- full-page: clones the whole body and ignores the tagger's returned
    // root, so it reaches the thread by a different path. Same assertions.
    const capFull = await capture('full-page');
    const full = await render(capFull);
    await assertItemClip(full.clipBody, 'full-page');
    await full.libPage.close();

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved stackernews-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
    refreshLiveGallery();
  }
});
