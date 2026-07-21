// Phase 4.1 — content-free quality heuristics for the corpus sweep.
//
// For a domain we've never curated there is no ground-truth "expected" clip, so
// we can't assert equality. Instead we score each capture with signals that
// suggest something is wrong WITHOUT knowing what "right" is, then rank the
// sweep worst-first and eyeball only the worst decile. Each heuristic maps onto
// a defect class the pipeline has fought before:
//
//   - textCoverage     mis-scoped root / captured-everything  (Phase 3.4 self-check)
//   - blankRatio       elements dropped mid-pipeline → holes
//   - aspectDistorted  stretched-avatar / blur-triplet blobs   (Phase 2 primal)
//   - chromeHits        generic chrome stripper missed this site (removeGenericChrome)
//
// The scores are a TRIAGE FILTER, not a pass/fail gate — false positives (a
// legitimately image-heavy or very short page) and false negatives (broken but
// plausible content) are expected and acceptable because a human reviews the
// ranked tail. The pixel-baseline fixture specs remain the real regression floor.

import type { SweepScores } from './sweepArtifacts';

// Raw per-heuristic measurements gathered in-page; combined into SweepScores in Node.
export interface SweepMeasurements {
  clipTextLen: number;
  pageTextLen: number;
  clipHeight: number;
  blankPx: number;
  imgTotal: number;
  aspectDistorted: number;
  chromeHits: number;
  chromeSamples: string[];
}

// Thresholds past which a heuristic is "flagged". Tuned conservatively — the
// goal is to surface the obviously-bad tail, not to nitpick. Adjust after the
// first ~50-domain run shows the score distribution.
export const THRESHOLDS = {
  textCoverageLow: 0.05,   // captured a sliver of the page
  textCoverageHigh: 0.9,   // captured essentially the whole page (chrome + all)
  blankRatio: 0.35,        // >35% of the clip is empty space
  aspectDistorted: 1,      // any badly-stretched image
  chromeHits: 3,           // 3+ known-chrome strings survived
};

/** Combine raw in-page measurements into normalised 0..1 scores + a composite
 *  (1 = worst) + the list of tripped heuristics. */
export function computeScores(m: SweepMeasurements): SweepScores {
  const textCoverage = m.pageTextLen > 0 ? m.clipTextLen / m.pageTextLen : 0;
  const blankRatio = m.clipHeight > 0 ? Math.min(1, m.blankPx / m.clipHeight) : 0;

  const flags: string[] = [];
  // Normalise each heuristic to a 0..1 "badness" contribution.
  // textCoverage: a sliver (captured almost nothing) is unambiguously bad. But
  // HIGH coverage is NOT a defect on its own — a minimal-chrome text page
  // (danluu, paulgraham, HN, Wikipedia article) legitimately captures ~90-100%
  // of its own text, and that's the healthy case, not chrome leaking in. So the
  // high-coverage signal only CONTRIBUTES to the composite when there's
  // independent evidence chrome survived (chromeHits > 0). Absent that, we still
  // surface an informational note but weight it zero so text-only pages don't
  // dominate the worst-decile with false positives.
  let textBad = 0;
  if (textCoverage < THRESHOLDS.textCoverageLow) {
    textBad = 1 - textCoverage / THRESHOLDS.textCoverageLow; // →1 as coverage→0
    flags.push(`text-coverage low (${(textCoverage * 100).toFixed(1)}%)`);
  } else if (textCoverage > THRESHOLDS.textCoverageHigh) {
    if (m.chromeHits > 0) {
      textBad = Math.min(1, (textCoverage - THRESHOLDS.textCoverageHigh) / (1 - THRESHOLDS.textCoverageHigh));
      flags.push(`text-coverage high (${(textCoverage * 100).toFixed(0)}% — chrome likely included)`);
    } else {
      // High coverage, zero chrome hits: healthy full-text capture. Note it
      // (a reviewer may still want to eyeball) but don't count it as badness.
      // Coverage can exceed 100% when the source page under-measured its own
      // innerText (lazy-loaded / cookie-walled body) — the clip legitimately
      // holds MORE text than the throttled live DOM did. A literal "2121%" reads
      // as a bug, so clamp the DISPLAYED figure to ">=100%" past 105%.
      const pct = textCoverage > 1.05 ? '≥100' : (textCoverage * 100).toFixed(0);
      flags.push(`text-coverage high (${pct}% — no chrome detected, likely healthy)`);
    }
  }

  const blankBad = Math.min(1, blankRatio / Math.max(THRESHOLDS.blankRatio, 0.001));
  if (blankRatio > THRESHOLDS.blankRatio) flags.push(`blank-space ${(blankRatio * 100).toFixed(0)}%`);

  // Distortion + chrome are counts; saturate to 1 over a small span so a couple
  // of hits already reads as "bad" without one outlier dominating the composite.
  const distortBad = Math.min(1, m.aspectDistorted / 4);
  if (m.aspectDistorted >= THRESHOLDS.aspectDistorted) flags.push(`${m.aspectDistorted} distorted image(s)`);

  const chromeBad = Math.min(1, m.chromeHits / 8);
  if (m.chromeHits >= THRESHOLDS.chromeHits) flags.push(`${m.chromeHits} chrome string(s)`);

  // Weighted composite. text-coverage and chrome are the strongest "this clip is
  // wrong" signals; blank + distortion are secondary. Weights sum to 1.
  const composite = Math.min(
    1,
    0.35 * textBad + 0.30 * chromeBad + 0.20 * blankBad + 0.15 * distortBad,
  );

  return {
    textCoverage: round(textCoverage),
    blankRatio: round(blankRatio),
    aspectDistorted: m.aspectDistorted,
    chromeHits: m.chromeHits,
    composite: round(composite),
    flags,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Chrome phrases the sweep looks for surviving in the clip body. A pragmatic
// mirror of capture.ts's internal chrome regexes (which aren't exported) —
// approximate is fine for a triage signal. Whole-token, case-insensitive.
export const CHROME_SWEEP_PHRASES = [
  'share this', 'save for later', 'sign up for our newsletter', 'subscribe to our newsletter',
  'never miss', 'directly to your inbox', 'add us on google', 'preferred source',
  'open comment sort options', 'show comments', 'load more comments', 'continue reading',
  'read more from', 'recommended for you', 'you might also like', 'trending now',
  'most popular', 'up next', 'related articles', 'advertisement', 'skip to content',
  'accept all cookies', 'manage cookies', 'we use cookies',
];

/** Runs INSIDE the browser (serialised to page.evaluate). Given the clip-body
 *  element, the source-page text length, and the chrome phrase list, returns raw
 *  measurements. Defined as a plain function so Playwright can inject it. */
export function measureInPage(
  clipBody: Element,
  pageTextLen: number,
  chromePhrases: string[],
): SweepMeasurements {
  const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
  const clipText = norm((clipBody as HTMLElement).innerText);
  const clipRect = clipBody.getBoundingClientRect();
  const clipHeight = clipRect.height;

  // Blank-space: walk top-level rendered blocks, sum vertical gaps between them
  // plus any trailing gap — a proxy for "content dropped out and left holes".
  let blankPx = 0;
  const children = Array.from(clipBody.children) as HTMLElement[];
  let cursor = clipRect.top;
  for (const c of children) {
    const r = c.getBoundingClientRect();
    if (r.height === 0) continue;
    if (r.top - cursor > 24) blankPx += r.top - cursor;
    cursor = Math.max(cursor, r.bottom);
  }
  if (clipRect.bottom - cursor > 24) blankPx += clipRect.bottom - cursor;

  // Aspect-distortion: rendered AR vs natural AR for loaded imgs.
  let aspectDistorted = 0;
  const imgs = Array.from(clipBody.querySelectorAll('img')) as HTMLImageElement[];
  for (const img of imgs) {
    if (!img.naturalWidth || !img.naturalHeight) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const naturalAR = img.naturalWidth / img.naturalHeight;
    const renderedAR = r.width / r.height;
    // Flag when the rendered AR is >2.2x off natural in either direction.
    if (renderedAR / naturalAR > 2.2 || naturalAR / renderedAR > 2.2) aspectDistorted++;
  }

  // Chrome hits: count phrases present in the clip text.
  const lower = clipText.toLowerCase();
  const chromeSamples: string[] = [];
  let chromeHits = 0;
  for (const p of chromePhrases) {
    if (lower.includes(p)) { chromeHits++; chromeSamples.push(p); }
  }

  return {
    clipTextLen: clipText.length,
    pageTextLen,
    clipHeight,
    blankPx,
    imgTotal: imgs.length,
    aspectDistorted,
    chromeHits,
    chromeSamples,
  };
}
