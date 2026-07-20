// Shared output router for LIVE visual specs. The three "hero" images every
// live *-visual spec produces — the source-site screenshot, the rendered clip,
// and the public cast — land together in test-output/live-visual-run/ so they're
// easy to review side by side. Debug artifacts (capture JSON, dx-marker dumps,
// DOM structure dumps, etc.) stay in the test-output/ root via each spec's `out()`.
//
// Filenames use a `{site}--N-{type}.png` scheme (--1-source, --2-clip, --3-cast)
// so a plain File-Explorer sort shows source → clip → cast in capture order.
// A `variant` suffix keeps extra crops grouped with their type
// (e.g. clip('reddit', 'top') -> reddit--2-clip-top.png).
//
// Usage in a spec:
//   const live = liveArtifacts('medium');
//   await page.screenshot({ path: live.source() });               // medium--1-source.png
//   await screenshotClipBody(libPage, clipBody, live.clip());     // medium--2-clip.png
//   await castShotSafe(page, cap, live.cast());                   // medium--3-cast.png
//   await libPage.screenshot({ path: live.clip('top') });         // medium--2-clip-top.png

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LiveArtifacts {
  source(variant?: string): string;
  clip(variant?: string): string;
  cast(variant?: string): string;
}

/** Returns typed path helpers that write into <repo>/test-output/live-visual-run/,
 *  creating the dir on first use. `site` is the filename prefix (e.g. 'medium'). */
export function liveArtifacts(site: string): LiveArtifacts {
  const dir = resolve(__dirname, '..', '..', '..', 'test-output', 'live-visual-run');
  mkdirSync(dir, { recursive: true });
  const path = (order: number, type: string, variant?: string) =>
    resolve(dir, `${site}--${order}-${type}${variant ? `-${variant}` : ''}.png`);
  return {
    source: (variant?: string) => path(1, 'source', variant),
    clip: (variant?: string) => path(2, 'clip', variant),
    cast: (variant?: string) => path(3, 'cast', variant),
  };
}
