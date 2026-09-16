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
import { rmSync } from 'node:fs';
import { buildLongFormCast } from './castFromCapture';
import { renderCastAndScreenshot } from './renderCast';

export interface CastShotOptions {
  /** Text expected in the feed row (defaults to the capture title). */
  rowText?: string;
  /** Evaluation to cast with (defaults to Worthwhile / General). */
  evaluation?: unknown;
  /** Cap for very tall cast bodies. */
  maxHeight?: number;
  /**
   * castShotSafe only: called with this run's cast outcome, so a caller that
   * keeps a per-domain record (the corpus sweep) can PERSIST the failure
   * instead of leaving "no cast image" to be guessed at. Optional — the 13
   * live-visual specs that just want the artifact ignore it.
   */
  onOutcome?: (outcome: { ok: boolean; reason?: string }) => void;
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
  // A TIME cap as well as a throw guard: "never fails the sweep" was only ever
  // true for throws, and an unbounded await inside (a networkidle goto against a
  // mocked, deliberately-open relay socket) hung until the caller's per-domain
  // deadline killed the whole domain. The cast is the LAST, additive artifact —
  // giving up on it must cost the run nothing.
  const CAST_BUDGET_MS = Number(process.env.SWEEP_CAST_TIMEOUT_MS ?? 90_000);
  try {
    const text = await Promise.race([
      castShot(capturePage, capture, screenshotPath, opts),
      new Promise<null>((_, rej) =>
        setTimeout(() => rej(new Error(`castShot timeout (>${CAST_BUDGET_MS}ms)`)), CAST_BUDGET_MS)),
    ]);
    // Not castable (bookmark / empty body): castShot wrote nothing, so any file
    // at this path belongs to an EARLIER run and must go — same reason as below.
    if (text === null) {
      discardStale(screenshotPath, 'not castable');
      opts.onOutcome?.({ ok: false, reason: 'not castable (no long-form body)' });
    } else {
      opts.onOutcome?.({ ok: true });
    }
    return text;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(`[castShot] cast render skipped: ${reason}`);
    discardStale(screenshotPath, reason);
    opts.onOutcome?.({ ok: false, reason });
    return null;
  }
}

/**
 * Delete the cast image at `path` when this run did not produce one.
 *
 * Swallowing the failure is right — the cast is additive and must never fail a
 * clip check that already passed — but LEAVING the previous run's PNG is not:
 * it sits beside a fresh clip and a fresh score.json with nothing marking it,
 * so it reads as this run's output. Measured 2026-09-16: github-pr captured ok
 * at 15:38 while its --3-cast.png was still 2026-08-30's, and a Phase 2 fix was
 * nearly reported as not working because that stale image was reviewed as
 * current. An ABSENT image is unambiguous; a stale one is a wrong answer.
 */
function discardStale(path: string, why: string): void {
  try {
    rmSync(path, { force: true });
    // eslint-disable-next-line no-console
    console.log(`[castShot] removed stale cast image (${why}): ${path}`);
  } catch {
    /* best effort — never let cleanup fail the caller */
  }
}
