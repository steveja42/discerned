// Phase 4.1 — content-free capture DIAGNOSTICS for the corpus sweep.
//
// These are recorded context, NOT a quality ranking. An earlier version combined
// them into a 0..1 `composite` that ranked the review queue worst-first; that was
// measured against 203 scored-and-reviewed domains and found ANTI-predictive:
//
//   AUC 0.445 (0.5 = coin flip)      worst-10 precision 1/10 = 10%
//   base rate of a critical/flaw verdict: 36.9%
//   63% of bad clips (47/75) scored <=0.02 — invisible to the ranking
//
// Per-heuristic AUC was 0.46-0.54, i.e. every signal sat at chance, and domains
// with NO flags were bad 37% of the time — exactly the base rate, so the flags
// carried no information. Sorting by composite was worse than alphabetical.
//
// The cause is structural, not a tuning problem: the defects that matter are
// semantic ("every comment duplicated", "headline missing", "captured the video
// rail instead of the article") and are invisible to text-length ratios, gap
// pixels and aspect ratios. apnews scored 0.005 with zero flags while capturing
// the wrong block entirely.
//
// So the numbers below are kept as CONTEXT a reviewer reads once already looking
// at an image, and the queue is ordered by whether the capture actually changed.
// Real quality signal comes from two places only: the pixel-baseline fixture
// specs (the regression floor) and a model/human reading the slices.

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

// Reference points for READING the diagnostics in the gallery (a value past one
// of these is worth a glance once you are already looking at the image). They no
// longer gate, flag or rank anything — see the header for why.
export const THRESHOLDS = {
  textCoverageLow: 0.05,   // captured a sliver of the page
  textCoverageHigh: 0.9,   // captured essentially the whole page (chrome + all)
  blankRatio: 0.35,        // >35% of the clip is empty space
  aspectDistorted: 1,      // any badly-stretched image
  chromeHits: 3,           // 3+ known-chrome strings survived
};

/** Combine raw in-page measurements into recorded diagnostics. No composite and
 *  no flags: see the header — they ranked below chance and are not computed. */
export function computeScores(m: SweepMeasurements): SweepScores {
  const textCoverage = m.pageTextLen > 0 ? m.clipTextLen / m.pageTextLen : 0;
  const blankRatio = m.clipHeight > 0 ? Math.min(1, m.blankPx / m.clipHeight) : 0;

  return {
    textCoverage: round(textCoverage),
    blankRatio: round(blankRatio),
    aspectDistorted: m.aspectDistorted,
    chromeHits: m.chromeHits,
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
