#!/usr/bin/env node
// Snapshot test-output/corpus-sweep-run/ to a timestamped sibling folder BEFORE
// a new sweep overwrites it in place. Without this, a regression is invisible —
// the new PNG silently replaces the old one and there is nothing to diff against.
//
// Usage: node tests/e2e/tools/backup-sweep-run.mjs
// Prints the backup path on success (so a caller/script can capture it).

import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
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
console.log(dest); // last line: bare path, for scripting
