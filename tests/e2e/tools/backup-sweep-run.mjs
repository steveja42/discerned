#!/usr/bin/env node
// Snapshot test-output/corpus-sweep-run/ to a timestamped sibling folder BEFORE
// a new sweep overwrites it in place. Without this, a regression is invisible —
// the new PNG silently replaces the old one and there is nothing to diff against.
//
// Usage: node tests/e2e/tools/backup-sweep-run.mjs
// Prints the backup path on success (so a caller/script can capture it).

import { cpSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_ROOT = resolve(import.meta.dirname, '..', '..', '..', 'test-output');
const SRC = resolve(OUT_ROOT, 'corpus-sweep-run');

if (!existsSync(SRC)) {
  console.log('No existing corpus-sweep-run/ to back up — first run, nothing to do.');
  process.exit(0);
}

const files = readdirSync(SRC).filter(f => statSync(resolve(SRC, f)).isFile());
if (files.length === 0) {
  console.log('corpus-sweep-run/ is empty — nothing to back up.');
  process.exit(0);
}

// Local time, not UTC — an ISO/UTC stamp reads several hours off from when the
// backup was actually taken, which is confusing when eyeballing folder names to
// pick the right "before" snapshot. sv-SE gives YYYY-MM-DD HH:mm:ss for free.
const now = new Date();
const stamp = now.toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T').replace(/:/g, '-');
const dest = resolve(OUT_ROOT, `corpus-sweep-run--backup-${stamp}`);

cpSync(SRC, dest, { recursive: true });
console.log(`Backed up ${files.length} files -> ${dest}`);

// Prune old snapshots. Each is ~550 MB, so they cannot be kept forever — but
// keeping too FEW loses the evidence a regression needs. Measured 2026-09-15:
// snapchat-web cast was fine on 09-12 and is 9/10 critical now, and with KEEP=2
// both surviving backups were from the same day, so the regression could not be
// demonstrated and had to be recorded as `regression: "none"`. Five spans a
// working week, which is the window in which a regression is actually noticed.
// KEEP counts backups INCLUDING the one just made.
const KEEP = Number(process.env.SWEEP_BACKUP_KEEP ?? 5);
const backups = readdirSync(OUT_ROOT)
  .filter(d => d.startsWith('corpus-sweep-run--backup-'))
  .sort(); // stamped YYYY-MM-DDTHH-mm-ss, so lexical order IS chronological
for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) {
  rmSync(resolve(OUT_ROOT, old), { recursive: true, force: true });
  console.log(`Pruned old backup: ${old}`);
}

console.log(dest); // last line: bare path, for scripting
