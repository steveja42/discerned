// One-call convenience for the live-visual specs: from a just-captured clip,
// build the public cast (via the extension's real BUILD_CAST test bridge) and
// screenshot how it renders in the feed. This is the third image per site
// ({site}-cast.png) beside {site}-source.png (the website) and
// {site}-rendered.png (the private clip).
//
// Add to a live-visual spec right after the clip screenshot:
//     await castShot(capturePage, cap, out('reddit-cast.png'), { rowText: 'parked' });
// It reuses the SAME capture object + the SAME loaded extension to BUILD the
// cast (so it's exactly what handleCast would publish), then renders it in a
// fresh extension-free browser. Failures here surface cast-render defects
// (brace spills, giant avatars, smashed digits) that the clip render hides.

import type { Page } from '@playwright/test';
import { buildLongFormCast } from './castFromCapture';
import { renderCastAndScreenshot } from './renderCast';

export interface CastShotOptions {
  /** Text expected in the feed row (defaults to the capture title). */
  rowText?: string;
  /** Evaluation to cast with (defaults to Worthwhile / General). */
  evaluation?: unknown;
  /** Cap for very tall cast bodies. */
  maxHeight?: number;
}

/**
 * Build + render + screenshot the public cast for a capture.
 *
 * @param capturePage  The page the capture came from — has the extension content
 *                     script, so the BUILD_CAST bridge is reachable.
 * @param capture      The capture object returned by the test capture bridge.
 * @param screenshotPath Where to write the cast screenshot.
 *
 * Returns the cast body's innerText (for optional assertions), or null when the
 * capture has no castable long-form body (bookmark / empty body) — in which case
 * no screenshot is written and the caller can simply move on.
 */
export async function castShot(
  capturePage: Page,
  capture: { title?: string } & Record<string, unknown>,
  screenshotPath: string,
  opts: CastShotOptions = {},
): Promise<string | null> {
  const event = await buildLongFormCast(capturePage, capture, opts.evaluation);
  if (!event) return null;
  return renderCastAndScreenshot(event, {
    rowText: opts.rowText ?? capture.title,
    screenshotPath,
    maxHeight: opts.maxHeight,
  });
}

/**
 * castShot that never throws — logs and returns null on any failure. The
 * cast render is an ADDITIVE third artifact in the live-visual specs; a flaky
 * live site or a feed hiccup must not fail the (primary) clip verification that
 * already passed. Use this in the live-visual specs; use castShot directly when
 * the cast render itself is the thing under test.
 */
export async function castShotSafe(
  capturePage: Page,
  capture: { title?: string } & Record<string, unknown>,
  screenshotPath: string,
  opts: CastShotOptions = {},
): Promise<string | null> {
  try {
    return await castShot(capturePage, capture, screenshotPath, opts);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[castShot] cast render skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
