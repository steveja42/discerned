// Phase 4.1 — output router for the corpus sweep. Same three-hero-image scheme
// as liveArtifacts (source / clip / cast) but writes into its OWN folder,
// test-output/corpus-sweep-run/, so a 50-domain sweep never mixes with the
// per-site live-visual-run gallery. Adds a per-domain score.json sidecar.
//
// Filenames: `{domain}--1-source.png / --2-clip.png / --3-cast.png` (same
// order-prefixed scheme the gallery groups on) + `{domain}--score.json`.
//
// Usage in the sweep spec:
//   const art = sweepArtifacts('theverge');
//   await page.screenshot({ path: art.source() });
//   await screenshotClipBody(libPage, clipBody, art.clip());
//   await castShotSafe(page, cap, art.cast());
//   writeFileSync(art.score(), JSON.stringify(record, null, 2));

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const SWEEP_RUN_DIR = resolve(__dirname, '..', '..', '..', 'test-output', 'corpus-sweep-run');

export interface SweepArtifacts {
  dir: string;
  source(variant?: string): string;
  clip(variant?: string): string;
  cast(variant?: string): string;
  /** Per-domain score/status sidecar path (JSON). */
  score(): string;
}

export function sweepArtifacts(domain: string): SweepArtifacts {
  mkdirSync(SWEEP_RUN_DIR, { recursive: true });
  const img = (order: number, type: string, variant?: string) =>
    resolve(SWEEP_RUN_DIR, `${domain}--${order}-${type}${variant ? `-${variant}` : ''}.png`);
  return {
    dir: SWEEP_RUN_DIR,
    source: (variant?: string) => img(1, 'source', variant),
    clip: (variant?: string) => img(2, 'clip', variant),
    cast: (variant?: string) => img(3, 'cast', variant),
    score: () => resolve(SWEEP_RUN_DIR, `${domain}--score.json`),
  };
}

/** One domain's sweep outcome, serialised to `{domain}--score.json` and read
 *  back by sweep-gallery.mjs to build the ranked review page. */
export interface SweepRecord {
  domain: string;
  url: string;
  /** ISO timestamp of the run. */
  ranAt: string;
  /** 'ok' = captured + scored; 'skip' = page never loaded (infra, not a finding). */
  status: 'ok' | 'skip';
  /** Present when status === 'skip': why the page didn't load. */
  skipReason?: string;
  /** The four heuristic scores + composite (present when status === 'ok'). */
  scores?: SweepScores;
}

export interface SweepScores {
  /** clip body text length / visible page text length (0..1+). */
  textCoverage: number;
  /** fraction of the clip's vertical extent that is empty space (0..1). */
  blankRatio: number;
  /** count of images whose rendered aspect ratio is badly off natural. */
  aspectDistorted: number;
  /** count of known page-chrome strings that survived into the clip body. */
  chromeHits: number;
  /** 0..1 composite, 1 = worst. Drives the gallery's worst-first sort. */
  composite: number;
  /** Short labels of the heuristics that tripped their threshold. */
  flags: string[];
}
