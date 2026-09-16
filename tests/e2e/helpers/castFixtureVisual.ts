// Shared driver for fixture-based CAST visual regression specs — the cast-side
// twin of fixtureVisual.ts.
//
// Every *-fixture-visual baseline screenshots the private CLIP (.clip-body
// rendered from the rich dx-* bodyHtml). The PUBLIC cast is a different render
// entirely: bodyHtml → htmlToMarkdown → kind-30023 → ReactMarkdown, a lossy
// conversion the clip render never touches. Until this driver existed there was
// no automated guard on it at all, so a cast-only regression (whitespace
// padding inside highlighted code, grey-pill link mangling, literal markdown
// leaking) left all 29 clip baselines green.
//
// The pipeline here is production code end to end:
//   fixture page → __DISCERNED_TEST_CAPTURE (real captureContext)
//                → __DISCERNED_TEST_CAST    (real deriveLongFormMarkdown
//                                            + real buildCastTemplates)
//                → sign with a throwaway key
//                → /discerns via a mocked relay (real feed + DetailPanel)
// Only the signing key and the relay are fakes; nothing about the markdown is
// reimplemented here.

import { expect, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './launchExtension';
import { activateExtensionOnTab } from './activateExtension';
import { buildLongFormCast } from './castFromCapture';
import { withRenderedCast } from './renderCast';

// Same fixed instant fixtureVisual.ts pins. A cast body carries no rendered
// date today, but the feed row does — pin it so a baseline that ever includes
// the app's own chrome can't rot the day after it is committed.
const FIXED_CAPTURE_TS = Date.UTC(2026, 0, 15, 12, 0, 0);

export interface CastFixtureVisualOptions {
  /** Slug for the fixture file AND the baseline name. */
  site: string;
  /** Fixture HTML filename (defaults to `${site}.html`). */
  fixtureFile?: string;
  /** Per-pixel tolerance. Matches the clip baselines' default. */
  maxDiffPixelRatio?: number;
  /** Pretend the fixture is served from this hostname so a site tagger fires. */
  hostOverride?: string;
  /** Companion to hostOverride for gates that branch on URL path shape. */
  pathOverride?: string;
  /** ClipFormat to drive. Defaults to 'article'. */
  format?: 'article' | 'full-page';
  /**
   * Text expected in the feed row, to select the right one. Defaults to the
   * cast's own title tag (which comes from the capture title).
   */
  rowText?: string;
  /**
   * Substrings that MUST appear in the rendered cast text, and substrings that
   * must NOT. These carry the actual defect claim — a pixel baseline says only
   * "something moved", while `castMustNotContain: ['r . json ()']` says which
   * bug came back. Run before the pixel assertion so the failure names itself.
   */
  castMustContain?: string[];
  castMustNotContain?: string[];
  /**
   * Substrings that are present TODAY because of a known, still-unfixed defect,
   * each mapped to the plan phase that owns it. They are reported as a summary
   * line rather than a failure, so the spec is green-but-honest: the pixel
   * baseline records the broken render, and when a phase fixes one of these the
   * spec fails LOUDLY ("no longer present") telling you to move the string into
   * castMustNotContain and refresh the baseline. Without this a known-broken
   * fixture is either a permanently red test everyone learns to ignore, or a
   * silent one that never notices the fix.
   */
  knownBroken?: Record<string, string>;
}

export async function runCastFixtureVisual(opts: CastFixtureVisualOptions): Promise<void> {
  const {
    site,
    fixtureFile = `${site}.html`,
    maxDiffPixelRatio = 0.02,
  } = opts;

  const fixtureUrl = `http://127.0.0.1:4173/${fixtureFile}`;
  const outDir = resolve(__dirname, '..', '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension({ headed: !!process.env.PWDEBUG_HEADED });
  let capture: Record<string, unknown>;
  try {
    capture = await captureFixture(ctx, fixtureUrl, opts);
  } finally {
    await ctx.close();
  }

  // Build + sign the cast OUTSIDE the extension context is not possible — the
  // BUILD_CAST bridge needs the content script — so it happens above, inside
  // captureFixture, and the signed event rides out on the capture object.
  const event = (capture.__castEvent ?? null) as Awaited<ReturnType<typeof buildLongFormCast>>;
  expect(event, `fixture "${site}" produced no long-form cast (not castable?)`).toBeTruthy();
  delete capture.__castEvent;

  await withRenderedCast(event!, { rowText: opts.rowText }, async (page, clipBody) => {
    const text = (await clipBody.innerText().catch(() => '')) ?? '';
    writeFileSync(out(`${site}-cast-fixture.txt`), text, 'utf8');
    // The kind-30023 content IS the derived long-form markdown — dumping it
    // from the signed event (rather than the capture, which never carries it
    // back across the bridge) gives the exact published source when a baseline
    // shifts and you need to see what the converter emitted.
    writeFileSync(out(`${site}-cast-fixture.md`), event!.content, 'utf8');

    // SOFT so they don't short-circuit the pixel baseline below. A fixture may
    // be deliberately known-broken (highlighted-code reproduces the Phase 2
    // whitespace bug on purpose) and still needs a baseline recording today's
    // state — otherwise the fix has nothing to be compared against. The test
    // still FAILS at the end of the step, naming which defect, rather than
    // reporting only "images differ".
    for (const needle of opts.castMustContain ?? []) {
      expect.soft(text, `cast body should contain ${JSON.stringify(needle)}`).toContain(needle);
    }
    for (const needle of opts.castMustNotContain ?? []) {
      expect.soft(text, `cast body should NOT contain ${JSON.stringify(needle)}`).not.toContain(needle);
    }

    // Known-broken ledger. Still-present defects are reported, not failed; a
    // defect that has GONE fails, because the baseline now lies.
    const fixed: string[] = [];
    for (const [needle, owner] of Object.entries(opts.knownBroken ?? {})) {
      if (text.includes(needle)) {
        // eslint-disable-next-line no-console
        console.log(`[cast:known-broken] ${site}: ${JSON.stringify(needle)} still present (${owner})`);
      } else {
        fixed.push(`${JSON.stringify(needle)} (${owner})`);
      }
    }
    expect(
      fixed,
      `known-broken cast defects are no longer present — move them to castMustNotContain and refresh the baseline:\n  ${fixed.join('\n  ')}`,
    ).toEqual([]);

    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.waitForTimeout(300);
    await clipBody.screenshot({ path: out(`${site}-cast-fixture-rendered.png`) });

    await expect(clipBody).toHaveScreenshot(`${site}-cast-fixture-body.png`, {
      maxDiffPixelRatio,
      timeout: 30_000,
    });
  });
}

/**
 * Load the fixture with the extension bound, run the real capture, then the
 * real cast build. Returns the capture with the signed cast event attached
 * under __castEvent (stripped by the caller) — both steps need the extension
 * context, which closes when this returns.
 */
async function captureFixture(
  ctx: BrowserContext,
  fixtureUrl: string,
  opts: CastFixtureVisualOptions,
): Promise<Record<string, unknown>> {
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('Discerned') || t.includes('dx-')) {
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}]`, t);
    }
  });
  // domcontentloaded (not 'load') so snapshotted pages with external
  // <img>/<script> references that 404 from 127.0.0.1 don't hang the spec.
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(500);

  // The content script is injected on demand (no broad host permission), so
  // bind it before posting to the test bridge — see CLAUDE.md, "Every spec must
  // activate before driving the test bridge".
  await activateExtensionOnTab(ctx, fixtureUrl);

  const cap = (await page.evaluate(async (
    { hostOverride, pathOverride, format }:
    { hostOverride: string | null; pathOverride: string | null; format: string },
  ) => {
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
  }, {
    hostOverride: opts.hostOverride ?? null,
    pathOverride: opts.pathOverride ?? null,
    format: opts.format ?? 'article',
  })) as Record<string, unknown>;

  const pinned = { ...cap, timestamp: FIXED_CAPTURE_TS };
  const event = await buildLongFormCast(page, pinned);
  return { ...pinned, __castEvent: event };
}
