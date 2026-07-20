// Fire-and-forget hook for live *-visual specs: after a run, (re)build
// test-output/live-visual-run/gallery.html from the captured images so the
// source/clip/cast strips can be reviewed side by side. Set OPEN_GALLERY=1 to also
// pop it open in the default browser when the spec finishes.
//
// Call in each live spec's `finally` block:  refreshLiveGallery();

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'tools', 'live-gallery.mjs');

/** Rebuild the gallery. Synchronous + best-effort — never throws, so a spec's
 *  teardown can't fail because of it. Opens the gallery if OPEN_GALLERY=1. */
export function refreshLiveGallery(): void {
  try {
    const args = [SCRIPT];
    if (process.env.OPEN_GALLERY) args.push('--open');
    spawnSync(process.execPath, args, { stdio: 'ignore', timeout: 15_000 });
  } catch { /* best effort — gallery is a review aid, not a test gate */ }
}
