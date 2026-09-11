#!/usr/bin/env node
// Delete a visual-findings.json verdict whenever the image it describes is no
// longer the CURRENT image for that domain — comparing against a prior run's
// (usually a backup's) own images byte-for-byte.
//
// WHY THIS EXISTS: visual-findings.json is a single long-lived file, never
// recreated per run — a domain re-captured by a new sweep simply leaves its old
// verdict sitting there untouched unless someone re-reviews it. Nothing marks
// that verdict as describing a STALE image. Measured 2026-09-09: of 206 live
// verdicts, 113 were byte-identical-looking "substantive" notes that in fact
// described an already-replaced image (the domain was re-captured, nobody
// re-opened the new picture) — indistinguishable from a genuinely fresh verdict
// by inspection, which is exactly what caused the back-and-forth confusion this
// tool exists to prevent. The user's rule: a verdict survives a new run ONLY if
// the image is byte-identical to what it was reviewed against; anything else
// loses its verdict rather than silently describing a different picture.
//
// Usage:
//   node tests/e2e/tools/prune-stale-findings.mjs <baseline-folder> [--run-dir <folder>] [--dry-run]
// baseline-folder: what to compare THIS run's images against (bare name under
//   test-output/, or absolute path) — typically the backup taken before this
//   sweep started.
// --run-dir: which findings file to prune (default: live corpus-sweep-run/).
// --dry-run: report what WOULD be deleted without writing anything.
//
// A verdict is KEPT only if:
//   - the domain's live status is 'ok' (a skip has no clip to hold a verdict for)
//   - the baseline has the same domain's clip AND cast images
//   - clip bytes match exactly, AND cast bytes match exactly (or both are
//     absent on both sides)
// Everything else is deleted — including domains with no baseline counterpart,
// which have nothing to prove they're unchanged.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, '..', '..', '..', 'test-output');

function resolveDir(arg) {
  if (!arg) return null;
  return resolve(arg) === arg ? arg : resolve(OUT_ROOT, arg);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const runDirIdx = args.indexOf('--run-dir');
const RUN_DIR = runDirIdx >= 0 ? resolveDir(args[runDirIdx + 1]) : resolve(OUT_ROOT, 'corpus-sweep-run');
const baselineArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--run-dir');
if (!baselineArg) {
  console.error('usage: prune-stale-findings.mjs <baseline-folder> [--run-dir <folder>] [--dry-run]');
  process.exit(1);
}
const BASELINE_DIR = resolveDir(baselineArg);
if (!existsSync(BASELINE_DIR)) {
  console.error(`baseline folder not found: ${BASELINE_DIR}`);
  process.exit(1);
}

const FINDINGS = resolve(RUN_DIR, 'visual-findings.json');
const doc = JSON.parse(readFileSync(FINDINGS, 'utf8'));

function sha1(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function sameImage(domain, kind) {
  const a = resolve(RUN_DIR, `${domain}--${kind}.png`);
  const b = resolve(BASELINE_DIR, `${domain}--${kind}.png`);
  const aExists = existsSync(a), bExists = existsSync(b);
  if (!aExists && !bExists) return true; // neither side ever had one — not a change
  if (aExists !== bExists) return false; // appeared or vanished
  return sha1(a) === sha1(b);
}

const kept = {};
const deleted = [];

for (const [domain, finding] of Object.entries(doc.findings ?? {})) {
  const scorePath = resolve(RUN_DIR, `${domain}--score.json`);
  let status;
  try { status = JSON.parse(readFileSync(scorePath, 'utf8')).status; } catch { status = null; }

  if (status !== 'ok') { deleted.push([domain, `live status=${status ?? 'missing'}`]); continue; }
  if (!existsSync(resolve(BASELINE_DIR, `${domain}--2-clip.png`))) {
    deleted.push([domain, 'no baseline clip to compare against']);
    continue;
  }
  const clipSame = sameImage(domain, '2-clip');
  const castSame = sameImage(domain, '3-cast');
  if (clipSame && castSame) {
    kept[domain] = finding;
  } else {
    deleted.push([domain, `clip_same=${clipSame} cast_same=${castSame}`]);
  }
}

console.log(`Baseline: ${BASELINE_DIR}`);
console.log(`Findings: ${FINDINGS}`);
console.log(`KEEP (image byte-identical to baseline): ${Object.keys(kept).length}`);
console.log(`DELETE (image changed / no baseline / not captured): ${deleted.length}`);
if (deleted.length) {
  console.log('\nDeleted domains:');
  for (const [d, reason] of deleted) console.log(`  ${d.padEnd(24)} ${reason}`);
}

if (dryRun) {
  console.log('\n--dry-run: no changes written.');
  process.exit(0);
}

if (deleted.length) {
  copyFileSync(FINDINGS, FINDINGS + '.bak');
  doc.findings = kept;
  writeFileSync(FINDINGS, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${FINDINGS} (${Object.keys(kept).length} verdicts kept, .bak saved).`);
} else {
  console.log('\nNothing to prune.');
}
