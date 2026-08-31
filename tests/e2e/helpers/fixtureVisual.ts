// Shared driver for fixture-based visual regression specs.
//
// Each fixture-visual spec calls runFixtureVisual({ site, ... }) — it loads
// the fixture from the fixture-server, drives captureContext() via the dev
// test bridge, renders the resulting clip through the web app's /clips,
// dumps debug artifacts to test-output/, then asserts the rendered .clip-body
// matches a pixel baseline.
//
// Site taggers don't fire on 127.0.0.1 (the hostname check in SITE_TAGGERS
// rejects it), so these specs only validate the GENERIC pipeline + shared CSS.
// That's intentional — they're the cheapest guard against shared-CSS / generic-
// heuristic regressions that would ripple across every site.

import { expect, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './launchExtension';
import { activateExtensionOnTab } from './activateExtension';
import { assertClipBodyHealth, type ClipHealthOptions } from './clipBodyHealth';

export interface FixtureVisualOptions {
  /** Slug used for the fixture file (e.g. "wikipedia") AND the baseline name. */
  site: string;
  /** Fixture HTML filename (defaults to `${site}.html`). */
  fixtureFile?: string;
  /** Viewport height for the screenshot. Bigger fixtures (long threads) need more. */
  viewportHeight?: number;
  /** Per-pixel tolerance. Default 0.02 matches medium/breitbart baselines. */
  maxDiffPixelRatio?: number;
  /** Pre-check selector that should appear in the clip body before screenshotting. */
  expectMarker?: string;
  /**
   * Pretend the fixture is served from this hostname so the matching site
   * tagger fires. Only honoured by `pnpm build:test` builds (the override
   * setter is tree-shaken in production). Use to validate tagPrimal /
   * tagBsky / tagReddit / tagYoutube / tagGoodreads / tagStackOverflow
   * against saved snapshots.
   */
  hostOverride?: string;
  /**
   * Companion to hostOverride for a gate that branches on URL PATH SHAPE, not
   * just hostname (isFacebookPostUrl: reel vs photo vs feed live at different
   * pathnames on the real site, which a 127.0.0.1/<name>.html fixture can
   * never reproduce). Pass a pathname+query like "/reel/123" to pin the shape
   * a specific fixture is meant to exercise.
   */
  pathOverride?: string;
  /**
   * ClipFormat to drive. Defaults to 'article'. Set 'full-page' to guard the
   * OTHER sticky format (STORAGE_KEYS.LAST_FORMAT persists the user's last
   * choice), which has its own extractor and so its own Tier-0 wiring.
   */
  format?: 'article' | 'full-page';
  /**
   * Use page.screenshot({ clip }) for the baseline instead of the default
   * element-level toHaveScreenshot on .clip-body. Set this for very tall
   * clips (50+ images) where the element-level "two stable screenshots"
   * stability check otherwise times out as the layout settles.
   */
  pageClipScreenshot?: boolean;
  /** Options forwarded to assertClipBodyHealth (e.g. disable a check). */
  health?: ClipHealthOptions;
}

export async function runFixtureVisual(opts: FixtureVisualOptions): Promise<void> {
  const {
    site,
    fixtureFile = `${site}.html`,
    viewportHeight = 1200,
    maxDiffPixelRatio = 0.02,
  } = opts;

  const fixtureUrl = `http://127.0.0.1:4173/${fixtureFile}`;

  const outDir = resolve(__dirname, '..', '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension({ headed: !!process.env.PWDEBUG_HEADED });
  try {
    await driveSpec(ctx, {
      site,
      fixtureUrl,
      viewportHeight,
      maxDiffPixelRatio,
      out,
      expectMarker: opts.expectMarker,
      hostOverride: opts.hostOverride,
      pathOverride: opts.pathOverride,
      format: opts.format,
      pageClipScreenshot: opts.pageClipScreenshot,
      health: opts.health,
    });
  } finally {
    await ctx.close();
  }
}

interface DriveArgs {
  site: string;
  fixtureUrl: string;
  viewportHeight: number;
  maxDiffPixelRatio: number;
  out: (name: string) => string;
  expectMarker?: string;
  hostOverride?: string;
  pathOverride?: string;
  format?: 'article' | 'full-page';
  pageClipScreenshot?: boolean;
  health?: ClipHealthOptions;
}

async function driveSpec(ctx: BrowserContext, args: DriveArgs): Promise<void> {
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('Discerned') || t.includes('dx-')) {
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}]`, t);
    }
  });
  // domcontentloaded (not 'load') so big snapshotted pages with external
  // <img>/<script> references that 404 from 127.0.0.1 don't hang the spec.
  // The capture pipeline only needs the DOM, not networked subresources.
  await page.goto(args.fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(500);

  // The content script is injected on demand (no broad host permission), so bind
  // it before posting to the test bridge — nothing would be listening otherwise.
  await activateExtensionOnTab(ctx, args.fixtureUrl);

  const cap = (await page.evaluate(async ({ hostOverride, pathOverride, format }: { hostOverride: string | null; pathOverride: string | null; format: string }) => {
    return new Promise((resolveCap, rejectCap) => {
      const timer = setTimeout(() => rejectCap(new Error('capture timeout')), 30_000);
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (e.data.error) rejectCap(new Error(e.data.error));
        else resolveCap(e.data.capture);
      };
      window.addEventListener('message', onMessage);
      window.postMessage(
        { type: '__DISCERNED_TEST_CAPTURE', format, hostOverride, pathOverride },
        window.location.origin,
      );
    });
  }, { hostOverride: args.hostOverride ?? null, pathOverride: args.pathOverride ?? null, format: args.format ?? 'article' })) as Record<string, unknown>;

  writeFileSync(
    args.out(`${args.site}-fixture-capture.json`),
    JSON.stringify(
      { ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').replace(/data:image\/[^"]+/g, 'IMG_INLINED') },
      null,
      2,
    ),
    'utf8',
  );

  const libPage = await ctx.newPage();
  await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
  await libPage.evaluate((capture) => {
    const clip = {
      capture,
      evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' },
      encrypted: '',
    };
    window.postMessage(
      { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
      window.location.origin,
    );
    window.postMessage(
      { type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] },
      window.location.origin,
    );
  }, cap);

  const row = libPage.locator('article.clip').first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
  const clipBody = libPage.locator('.clip-body');
  await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
  await libPage.waitForTimeout(1000);

  // Wait for every <img> in the clip body to finish decoding. Large clips
  // (Goodreads, YouTube) inline 50+ images and the layout keeps reflowing
  // as each decodes — toHaveScreenshot's "two stable screenshots" check
  // will time out otherwise. Force a fixed width on each img too so lazy
  // intrinsic-sizing doesn't trigger a second reflow mid-screenshot.
  await clipBody.evaluate(async (root) => {
    const imgs = Array.from(root.querySelectorAll('img'));
    await Promise.all(imgs.map(img =>
      (img.complete && img.naturalWidth > 0)
        ? Promise.resolve()
        : img.decode().catch(() => undefined),
    ));
    // Pin each img to its decoded natural size so a second decode pass
    // doesn't shift layout during the stability check.
    for (const img of imgs) {
      if (img.naturalWidth > 0 && !img.style.width) {
        img.style.width = `${img.clientWidth}px`;
        img.style.height = `${img.clientHeight}px`;
      }
    }
  });
  await libPage.waitForTimeout(500);

  await libPage.setViewportSize({ width: 1280, height: args.viewportHeight + 200 });
  await libPage.waitForTimeout(300);
  await libPage.screenshot({
    path: args.out(`${args.site}-fixture-rendered.png`),
    clip: { x: 0, y: 0, width: 1280, height: args.viewportHeight },
  });

  if (args.expectMarker) {
    const found = await clipBody.evaluate(
      (root, sel) => !!(root as Element).querySelector(sel),
      args.expectMarker,
    );
    expect(found, `expected marker "${args.expectMarker}" in clip body`).toBe(true);
  }

  // Structural health checks — catch layout defects (stretched imgs, crushed
  // columns, blank runs, chrome leaks) that a pixel diff only reports as
  // "images differ" without saying why.
  await assertClipBodyHealth(clipBody, args.health);

  // Pixel baseline. Regenerate with `--update-snapshots` after intentional
  // visual changes. Snapshot files live next to the calling spec under
  // tests/e2e/<site>-fixture-visual.spec.ts-snapshots/.
  //
  // 30s timeout (vs default 5s) accommodates very large clip bodies — real
  // Goodreads / YouTube snapshots inline 50+ images and the "waiting for
  // element to be stable" check needs time as the layout settles.
  //
  // Sites with very tall clip bodies (50+ images, multi-screen scroll) opt
  // into a viewport-clipped page screenshot via pageClipScreenshot: true —
  // toHaveScreenshot's element-stability check can't tolerate the small
  // reflows that still happen even after image.decode() finishes.
  if (args.pageClipScreenshot) {
    await expect(libPage).toHaveScreenshot(`${args.site}-fixture-clipbody.png`, {
      maxDiffPixelRatio: args.maxDiffPixelRatio,
      clip: { x: 0, y: 0, width: 1280, height: args.viewportHeight },
      timeout: 30_000,
    });
  } else {
    await expect(clipBody).toHaveScreenshot(`${args.site}-fixture-clipbody.png`, {
      maxDiffPixelRatio: args.maxDiffPixelRatio,
      timeout: 30_000,
    });
  }
}
