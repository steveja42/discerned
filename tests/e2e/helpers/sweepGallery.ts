// Phase 4.1 — fire-and-forget hook to (re)build the corpus-sweep review gallery
// after a sweep run. Mirrors liveGallery.ts but points at the sweep tool +
// folder. Best-effort — never throws (the gallery is a review aid, not a gate).
//
// Call in the sweep spec after writing all score.json sidecars:
//   refreshSweepGallery();
// Set OPEN_GALLERY=1 to also pop it open in the default browser.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'tools', 'sweep-gallery.mjs');

export function refreshSweepGallery(): void {
  try {
    const args = [SCRIPT];
    if (process.env.OPEN_GALLERY) args.push('--open');
    spawnSync(process.execPath, args, { stdio: 'ignore', timeout: 15_000 });
  } catch { /* best effort */ }
}
