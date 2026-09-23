// The ONE definition of "does this capture still need a visual review?".
//
// Shared by review-queue.mjs (the standing query, and the only writer/pruner)
// and watch-sweep-stream.mjs (the live announcer during a sweep). It lives in
// one module because the two MUST agree: if the stream says a domain is fine
// while the queue says it is pending, the reviewer is being lied to by
// whichever one they happen to be reading. Two independent definitions of
// "needs review" have already drifted twice in this codebase (mtime-vs-content,
// and `where`-as-coverage), each time producing a wrong answer that looked
// authoritative.
//
// THE RULE, applied to the clip and the cast SEPARATELY:
//
//   a surface needs review if it has no review stamp, OR if its image differs
//   from the baseline AND that surface's own review predates this capture.
//   Otherwise leave it alone.
//
// Both clauses are load-bearing. Measured on a live 209-domain run: 208 of 209
// images differed from the baseline (a sweep changes nearly everything) while
// only a handful of verdicts predated their capture. The image test alone would
// therefore prune essentially the whole corpus; the timestamp test alone would
// keep verdicts describing replaced pictures.
//
// NEVER use mtime for this. A sweep rewrites every PNG whether or not the
// capture changed, so an mtime test marks a byte-identical re-capture stale —
// that queued 209 of 209 domains after any re-run.
//
// `where` is NOT coverage. It records where the DEFECT is; a reviewer routinely
// reads both surfaces and names the one with the problem. Coverage lives only
// in clipReviewedAt / castReviewedAt.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';

export function md5(path) {
  try { return createHash('md5').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

/**
 * Most recent `corpus-sweep-run--backup-*` folder under outRoot, or null.
 * Used only to ask "did this image change?" — it makes no quality claim.
 */
export function findBaselineDir(outRoot) {
  try {
    const backups = readdirSync(outRoot)
      .filter(f => f.startsWith('corpus-sweep-run--backup-'))
      .sort();
    return backups.length ? resolve(outRoot, backups[backups.length - 1]) : null;
  } catch {
    return null;   // no backups — every capture reads as new
  }
}

/**
 * The rule, for a single surface.
 *
 * No image means nothing to look at, so nothing is owed a review — whether that
 * is a known not-castable page (rec.cast.ok === false, e.g. a 90s render
 * timeout) or an unexplained absence. Callers tell those apart for the reader
 * via the sidecar's own `cast.reason`.
 *
 * @param {string} imgPath      the PNG on disk now
 * @param {string|null} stampedAt  that surface's own review stamp
 * @param {{ranAt?: string}} rec   the domain's --score.json
 * @param {string|null} baselineDir
 */
export function surfaceState(imgPath, stampedAt, rec, baselineDir) {
  if (!existsSync(imgPath)) return { needsReview: false, stale: false };
  if (!stampedAt) return { needsReview: true, stale: false };   // never reviewed
  // A baseline lacking this image cannot prove it unchanged -> treat as changed.
  const basePath = baselineDir ? resolve(baselineDir, basename(imgPath)) : null;
  const baseHash = basePath ? md5(basePath) : null;
  const changed = !baseHash || baseHash !== md5(imgPath);
  const older = rec.ranAt && Date.parse(stampedAt) < Date.parse(rec.ranAt);
  const stale = changed && !!older;
  return { needsReview: stale, stale };
}

/**
 * Which KINDS entry describes this domain — most specific first. A surface is
 * 'restale' when its image CHANGED since review, 'unchecked' when it has no
 * review stamp at all (never looked at, or cleared by an earlier prune).
 * both-unchecked must say so rather than naming one surface: a half-true label
 * sends the reviewer to one image and implies the other was already done.
 */
export function reviewKind(finding, clipState, castState) {
  if (!finding) return 'new';
  if (clipState.stale && castState.stale) return 'restale';
  if (clipState.stale) return 'restale-clip';
  if (castState.stale) return 'restale-cast';
  if (clipState.needsReview && castState.needsReview) return 'both-unchecked';
  return clipState.needsReview ? 'clip-unchecked' : 'cast-unchecked';
}

/**
 * Every review state in one table: its sort rank and the label a row prints.
 * Kept together so the two can't drift — adding a state means adding one line.
 * Ordered worst-first: never reviewed, then both surfaces changed, then one.
 */
export const KINDS = {
  new:               { rank: 0, tag: '' },
  restale:           { rank: 1, tag: ' [re-captured, clip+cast both changed]' },
  'restale-clip':    { rank: 2, tag: ' [CLIP changed — cast review still stands]' },
  'restale-cast':    { rank: 3, tag: ' [CAST changed — clip review still stands]' },
  'both-unchecked':  { rank: 4, tag: ' [NOT REVIEWED — clip and cast]' },
  'cast-unchecked':  { rank: 5, tag: ' [clip reviewed, CAST NOT CHECKED]' },
  'clip-unchecked':  { rank: 6, tag: ' [cast reviewed, CLIP NOT CHECKED]' },
};

/**
 * Both surfaces at once, for a domain that captured ok. Returns the per-surface
 * states plus whether anything needs a look and which KINDS entry applies.
 */
export function domainReviewState({ runDir, domain, finding, rec, baselineDir }) {
  const clip = resolve(runDir, `${domain}--2-clip.png`);
  const cast = resolve(runDir, `${domain}--3-cast.png`);
  const clipState = surfaceState(clip, finding?.clipReviewedAt, rec, baselineDir);
  const castState = surfaceState(cast, finding?.castReviewedAt, rec, baselineDir);
  return {
    clipState,
    castState,
    pending: clipState.needsReview || castState.needsReview,
    kind: reviewKind(finding, clipState, castState),
  };
}
