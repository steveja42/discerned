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
//   node tests/e2e/tools/review-queue.mjs              # pending, changed-captures first
//   node tests/e2e/tools/review-queue.mjs --limit 15   # next N only
//   node tests/e2e/tools/review-queue.mjs --stats      # counts only, no list
//   node tests/e2e/tools/review-queue.mjs --json       # machine-readable
//   node tests/e2e/tools/review-queue.mjs --all        # include already-reviewed

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
// ── Triage order: did the CAPTURE change? ───────────────────────────
// The queue used to be ordered worst-composite-first. Measured against 203
// scored-and-reviewed domains that ranking was ANTI-predictive (AUC 0.445; the
// worst-10 held 1 bad clip against a 36.9% base rate, and 47 of 75 bad clips
// scored <=0.02), so it reliably sent the reviewer to the wrong domains first.
//
// What IS objective is whether this run's clip differs from the baseline's. It
// makes no claim about quality — only that there is something new to look at,
// which is exactly the triage question. A byte-identical clip whose verdict is
// merely stale can wait; a changed one cannot.
function md5(path) {
  try { return createHash('md5').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

// Most recent backup folder, used only to ask "did this clip change?".
let baselineDir = null;
try {
  const backups = readdirSync(OUT_ROOT)
    .filter(f => f.startsWith('corpus-sweep-run--backup-'))
    .sort();
  if (backups.length) baselineDir = resolve(OUT_ROOT, backups[backups.length - 1]);
} catch { /* no backups — every capture reads as new */ }

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
      domain, kind: 'blocked', changed: true, scores: null,
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
  // `cast` is a path built by resolve(), so it is ALWAYS truthy — the old
  // `!cast` escape hatch never fired. Test the FILE, and only excuse the cast
  // check when this run recorded that it produced no cast image (rec.cast.ok
  // === false, e.g. a bookmark with no long-form body). An absent image with no
  // such record is a harness problem, flagged below rather than waved through.
  const castOnDisk = existsSync(cast);
  const castReported = rec.cast && rec.cast.ok === false;
  const castChecked = (!castOnDisk && castReported)
    || ['both', 'clip+cast', 'cast'].includes(finding?.where);
  const pending = !finding || stale || !finding.reviewedAt || !castChecked;

  if (!pending && !includeReviewed) continue;

  // null = no baseline to compare against (treated as "changed", i.e. review it).
  const baseClip = baselineDir ? resolve(baselineDir, `${domain}--2-clip.png`) : null;
  const baseHash = baseClip ? md5(baseClip) : null;
  const changed = !baseHash || baseHash !== md5(clip);

  rows.push({
    domain,
    kind: !finding ? 'new'
      : stale ? 'restale'
      : !finding.reviewedAt ? 'unstamped'
      : 'cast-unchecked',
    changed,
    scores: rec.scores ?? null,
    bodySettle: rec.bodySettle ?? null,
    verdict: finding?.verdict ?? null,
    clip: existsSync(clip) ? clip : null,
    cast: castOnDisk ? cast : null,
    source: existsSync(source) ? source : null,
    // Why there is no cast image, when there isn't one. A recorded reason is a
    // known outcome (not castable / render failed); no record at all means the
    // file went missing outside the sweep's knowledge.
    castMissing: castOnDisk ? null : (rec.cast?.reason ?? 'no cast recorded for this run'),
  });
}

// Blocked first (they need an action, not an eyeball), then captures that
// actually CHANGED since the baseline, then the rest alphabetically. See the
// md5 helper above for why this replaced the composite ranking.
const KIND_RANK = { new: 0, restale: 1, unstamped: 2, 'cast-unchecked': 3 };
rows.sort((a, b) => {
  if (a.kind === 'blocked' && b.kind !== 'blocked') return -1;
  if (b.kind === 'blocked' && a.kind !== 'blocked') return 1;
  if (a.changed !== b.changed) return a.changed ? -1 : 1;
  const k = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
  if (k) return k;
  return a.domain.localeCompare(b.domain);
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
  const changedCount = pendingRows.filter(r => r.changed).length;
  console.log(`\nAWAITING REVIEW (${pendingRows.length}; ${changedCount} with a changed capture, listed first):`);
  for (const r of pendingRows.slice(0, limit)) {
    const tag = r.kind === 'restale' ? ' [re-captured, verdict stale]'
      : r.kind === 'unstamped' ? ' [unverified bulk verdict]'
      : r.kind === 'cast-unchecked' ? ' [clip verified, CAST NOT CHECKED]' : '';
    const mark = r.changed ? 'CHANGED' : '  same ';
    const cov = r.scores ? ` cov=${(r.scores.textCoverage * 100).toFixed(0)}%` : '';
    const chrome = r.scores?.chromeHits ? ` chrome=${r.scores.chromeHits}` : '';
    // The page was STILL growing when captured, so a thin clip here is suspect
    // TIMING, not necessarily a pipeline defect — re-capture before filing a
    // verdict. See helpers/waitForBodySettled (politico: 5% one run, 87% the
    // next, from identical code).
    const unsettled = r.bodySettle && r.bodySettle.settled === false ? ' ⏳UNSETTLED' : '';
    console.log(`  ${mark}  ${r.domain.padEnd(24)}${cov}${chrome}${unsettled}${tag}`);
    if (r.clip) console.log(`      ${r.clip}`);
    if (r.cast) console.log(`      ${r.cast}`);
    // Say so explicitly. A silently absent cast image used to be indistinguish-
    // able from one that simply wasn't listed, and before it was deleted it was
    // worse: the PREVIOUS run's cast sat there and got reviewed as current.
    else console.log(`      (no cast image — ${r.castMissing})`);
  }
}

if (!blocked.length && !pendingRows.length) {
  console.log('\nNothing pending — every captured domain has a current verdict.');
}
