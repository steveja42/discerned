#!/usr/bin/env node
// Review queue for the corpus sweep — the piece that lets EYEBALLING run in
// parallel with capture instead of after it.
//
// The sweep takes hours; a reviewer who waits for it to finish then reads 206
// images serially doubles the wall-clock. But the sweep writes each domain's
// three PNGs + score.json the moment that domain finishes, so the images are
// reviewable long before the run ends. This tool answers one question cheaply
// and repeatedly: "which domains are captured but not yet reviewed?"
//
// It is deliberately a QUEUE, not a viewer. It prints a short list of file
// paths; the reviewer (a human, or Claude via the Read tool) opens those images
// and writes verdicts back with `record-verdict.mjs`. Keeping it to paths is
// what makes the loop token-cheap: no image is re-read once its verdict is in.
//
// "Needs review" = captured ok AND (no verdict yet OR the PNG is newer than the
// verdict). That second clause matters on a re-sweep: a domain re-captured after
// a fix carries a STALE verdict describing the old image, which is exactly the
// case [[feedback_refresh_gallery_and_verdict_after_each_fix]] exists to catch.
//
// Usage:
//   node tests/e2e/tools/review-queue.mjs              # pending, worst-score first
//   node tests/e2e/tools/review-queue.mjs --limit 15   # next N only
//   node tests/e2e/tools/review-queue.mjs --stats      # counts only, no list
//   node tests/e2e/tools/review-queue.mjs --json       # machine-readable
//   node tests/e2e/tools/review-queue.mjs --all        # include already-reviewed

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, '..', '..', '..', 'test-output');

const args = process.argv.slice(2);
// --run-dir (or SWEEP_RUN_DIR) points the queue at a BACKUP folder instead of
// the live corpus-sweep-run/ — e.g. to verify a prior full run's images before
// trusting it as the regression baseline (see project_google_referral... and
// the "recheck" verdict tier: regression detection needs a STAMPED baseline,
// which means the backup itself must go through this same queue once).
// Bare name or relative path resolves under test-output/; absolute path used
// as-is.
// indexOf returns -1 when absent, and args[-1 + 1] === args[0] — so a bare
// `.indexOf(...) + 1` silently reads the FIRST unrelated arg as the run-dir
// whenever --run-dir itself is missing (observed: `--stats` alone got read as
// a run-dir named "--stats" and crashed on a nonexistent folder). Guard the
// index explicitly.
const runDirIdx = args.indexOf('--run-dir');
const runDirArg = runDirIdx >= 0 ? args[runDirIdx + 1] : process.env.SWEEP_RUN_DIR;
const RUN_DIR = runDirArg
  ? (resolve(runDirArg) === runDirArg ? runDirArg : resolve(OUT_ROOT, runDirArg))
  : resolve(OUT_ROOT, 'corpus-sweep-run');
const FINDINGS = resolve(RUN_DIR, 'visual-findings.json');

const asJson = args.includes('--json');
const statsOnly = args.includes('--stats');
const includeReviewed = args.includes('--all');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

function loadFindings() {
  try {
    return JSON.parse(readFileSync(FINDINGS, 'utf8')).findings ?? {};
  } catch {
    return {};
  }
}

function mtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

const findings = loadFindings();
const rows = [];

for (const f of readdirSync(RUN_DIR)) {
  const m = f.match(/^(.+)--score\.json$/);
  if (!m) continue;
  const domain = m[1];
  let rec;
  try { rec = JSON.parse(readFileSync(resolve(RUN_DIR, f), 'utf8')); } catch { continue; }

  const clip = resolve(RUN_DIR, `${domain}--2-clip.png`);
  const cast = resolve(RUN_DIR, `${domain}--3-cast.png`);
  const source = resolve(RUN_DIR, `${domain}--1-source.png`);
  const finding = findings[domain];

  // A skip has no clip to look at. Surface it as its own bucket so it is
  // triaged as a BLOCK (retry / mark blocked), never silently counted as
  // reviewed — a skipped domain is the one most likely to need action.
  if (rec.status !== 'ok') {
    rows.push({
      domain, kind: 'blocked', composite: null,
      reason: rec.skipReason ?? 'skipped', verdict: finding?.verdict ?? null,
    });
    continue;
  }

  const imgAt = Math.max(mtime(clip), mtime(cast));
  // reviewedAt is stamped by record-verdict.mjs. A verdict with no stamp is
  // from the bulk-entered era — treat as stale so it gets re-confirmed once.
  const reviewedAt = finding?.reviewedAt ? Date.parse(finding.reviewedAt) : 0;
  const stale = !!finding && imgAt > 0 && reviewedAt > 0 && imgAt > reviewedAt + 1000;
  // A verdict covering only the clip is INCOMPLETE: the cast is a separate
  // render (kind-30023 markdown through /discerns) with its own failure modes —
  // dropped headline, clipped link pills, missing images — that a clean clip
  // hides. bbc-news is the proof: clip clean, cast missing its headline with
  // links rendered as truncated grey pills. So `where: "clip"` still counts as
  // pending until the cast has been looked at too.
  const castChecked = !cast || ['both', 'clip+cast', 'cast'].includes(finding?.where);
  const pending = !finding || stale || !finding.reviewedAt || !castChecked;

  if (!pending && !includeReviewed) continue;

  rows.push({
    domain,
    kind: !finding ? 'new'
      : stale ? 'restale'
      : !finding.reviewedAt ? 'unstamped'
      : 'cast-unchecked',
    composite: rec.scores?.composite ?? null,
    flags: rec.scores?.flags ?? [],
    verdict: finding?.verdict ?? null,
    clip: existsSync(clip) ? clip : null,
    cast: existsSync(cast) ? cast : null,
    source: existsSync(source) ? source : null,
  });
}

// Worst composite first: the scorer can't judge a clip, but it reliably ranks
// which ones are most likely to be worth a human's first look.
rows.sort((a, b) => {
  if (a.kind === 'blocked' && b.kind !== 'blocked') return -1;
  if (b.kind === 'blocked' && a.kind !== 'blocked') return 1;
  return (b.composite ?? 0) - (a.composite ?? 0);
});

const blocked = rows.filter(r => r.kind === 'blocked');
const pendingRows = rows.filter(r => r.kind !== 'blocked');
const totalScored = readdirSync(RUN_DIR).filter(f => /--score\.json$/.test(f)).length;

if (asJson) {
  console.log(JSON.stringify({
    total: totalScored,
    pending: pendingRows.length,
    blocked: blocked.length,
    rows: rows.slice(0, limit),
  }, null, 2));
  process.exit(0);
}

console.log(`Sweep review queue — ${totalScored} captured · ${pendingRows.length} awaiting review · ${blocked.length} blocked`);

if (statsOnly) process.exit(0);

if (blocked.length) {
  console.log(`\nBLOCKED (${blocked.length}) — no clip to review; retry or mark blocked:`);
  for (const r of blocked.slice(0, limit)) {
    console.log(`  ${r.domain.padEnd(24)} ${String(r.reason).slice(0, 70)}`);
  }
  console.log(`\n  SWEEP_ONLY=${blocked.map(r => r.domain).join(',')}`);
}

if (pendingRows.length) {
  console.log(`\nAWAITING REVIEW (${pendingRows.length}, worst score first):`);
  for (const r of pendingRows.slice(0, limit)) {
    const tag = r.kind === 'restale' ? ' [re-captured, verdict stale]'
      : r.kind === 'unstamped' ? ' [unverified bulk verdict]'
      : r.kind === 'cast-unchecked' ? ' [clip verified, CAST NOT CHECKED]' : '';
    const flags = r.flags?.length ? `  [${r.flags.join(', ')}]` : '';
    console.log(`  ${(r.composite ?? 0).toFixed(3)}  ${r.domain.padEnd(24)}${flags}${tag}`);
    if (r.clip) console.log(`      ${r.clip}`);
    if (r.cast) console.log(`      ${r.cast}`);
  }
}

if (!blocked.length && !pendingRows.length) {
  console.log('\nNothing pending — every captured domain has a current verdict.');
}
