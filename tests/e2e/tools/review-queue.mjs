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
// ONE RULE, applied per surface (clip and cast separately):
//
//   a surface needs review if it has no review stamp, OR if its image differs
//   from the baseline AND that surface's own review predates this capture.
//   Otherwise leave it alone.
//
// Both clauses are load-bearing. Measured on the live 209-domain run: 208 of
// 209 images differ from the baseline (a sweep changes nearly everything) while
// only 3 verdicts predate their capture. So the image test alone would prune
// the whole corpus, and the timestamp test alone would keep verdicts describing
// replaced pictures. Together they queue 23 domains and prune 3.
//
// NEVER use mtime. A sweep rewrites every PNG whether or not the capture
// changed, so an mtime test marks byte-identical re-captures stale — that is
// what made an earlier version queue 209 of 209 domains after any re-run.
//
// The review stamp MUST be per surface. A single reviewedAt becomes false for
// one surface the moment the two are reviewed at different times: after a
// cast-only re-review it reports the cast's date as though it were the clip's,
// so a clip unexamined for two sweeps reads as current.
//
// `where` is NOT coverage — it records where the DEFECT is, and a reviewer
// routinely looks at both surfaces then names one (cbc, where=cast: "Clip is
// complete ... the cast still renders the hero as literal alt text"). Reading
// it as "which surfaces were reviewed" wrongly re-queues 16 clips and was the
// bug behind a bogus "[cast re-captured...]" note prefix. Coverage lives in
// clipReviewedAt / castReviewedAt, nowhere else.
//
// PRUNING IS AUTOMATIC: a stale surface loses its review stamp on every run, so
// the file never accumulates stamps asserting a review of a replaced picture
// (the 2026-09-09 state where 113 of 206 verdicts silently described one).
// verdict / severity / note / where are left INTACT — when only one surface is
// stale the note still describes the other, and the reviewer reads it from
// visual-findings.json for context. Pass --no-prune to inspect without writing.
//
// Usage:
//   node tests/e2e/tools/review-queue.mjs              # pending, changed-captures first
//   node tests/e2e/tools/review-queue.mjs --limit 15   # next N only
//   node tests/e2e/tools/review-queue.mjs --stats      # counts only, no list
//   node tests/e2e/tools/review-queue.mjs --json       # machine-readable
//   node tests/e2e/tools/review-queue.mjs --all        # include already-reviewed
//   node tests/e2e/tools/review-queue.mjs --no-prune   # never write findings
//   node tests/e2e/tools/review-queue.mjs --run-dir corpus-sweep-run--backup-<stamp> --no-prune
//                                                      # inspect a backup, read-only
//
// A REVIEW LOOP, end to end:
//
//   # 1. What needs looking at? Each row names the surface(s) and prints paths.
//   $ node tests/e2e/tools/review-queue.mjs --limit 5
//   Sweep review queue — 209 captured · 2 awaiting review · 0 blocked
//     cleared 0 clip + 2 cast review stamp(s) — image changed since it was reviewed (notes kept)
//
//   AWAITING REVIEW (2; 2 with a changed capture, listed first):
//     CHANGED  deepmind-blog     cov=77% [NOT REVIEWED — clip and cast]
//         .../deepmind-blog--2-clip.png
//         .../deepmind-blog--3-cast.png
//     CHANGED  cbc               cov=72% [cast reviewed, CLIP NOT CHECKED]
//         .../cbc--2-clip.png
//         .../cbc--3-cast.png
//
//   # 2. Read the image(s) the row names. For a partial re-review, read the
//   #    existing note in visual-findings.json first — it still describes the
//   #    surface that did NOT change.
//
//   # 3. Record it. `where` = where the DEFECT is; `--reviewed` = what you
//   #    LOOKED AT (default both). Re-checking one surface only:
//   $ node tests/e2e/tools/record-verdict.mjs cbc flaw cast \
//       "Cast renders the hero as literal alt text." --severity 4 --reviewed cast
//
//   # 4. A batch is one atomic write — preferred while working through a run:
//   $ node tests/e2e/tools/record-verdict.mjs --batch-file verdicts.json

import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
// The staleness rule lives in one place, shared with watch-sweep-stream.mjs —
// see that module's header for why the two must not have separate copies.
import { md5, findBaselineDir, surfaceState, reviewKind, KINDS } from './lib/review-state.mjs';
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
// Pruning writes to visual-findings.json. Default ON (see the header), opt-out
// for a pure read — e.g. inspecting a backup you do not want to modify.
const noPrune = args.includes('--no-prune');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

function loadFindings() {
  try {
    return JSON.parse(readFileSync(FINDINGS, 'utf8')).findings ?? {};
  } catch {
    return {};
  }
}

const findings = loadFindings();
// Surfaces whose image changed since their review, collected during the scan
// and written back once at the end (one atomic write, like record-verdict.mjs).
const pruneTargets = [];
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
// Most recent backup folder, used only to ask "did this clip change?".
const baselineDir = findBaselineDir(OUT_ROOT);

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

  const castOnDisk = existsSync(cast);

  // The cast is a separate render (kind-30023 markdown through /discerns) with
  // its own failure modes — dropped headline, clipped link pills, missing
  // images — that a clean clip hides. bbc-news is the proof: clip clean, cast
  // missing its headline. Hence a per-surface verdict, never one for both.
  const clipState = surfaceState(clip, finding?.clipReviewedAt, rec, baselineDir);
  const castState = surfaceState(cast, finding?.castReviewedAt, rec, baselineDir);
  const pending = clipState.needsReview || castState.needsReview;

  if (finding && (clipState.stale || castState.stale)) {
    pruneTargets.push({ domain, clipStale: clipState.stale, castStale: castState.stale });
  }

  if (!pending && !includeReviewed) continue;

  // null = no baseline to compare against (treated as "changed", i.e. review it).
  const baseClip = baselineDir ? resolve(baselineDir, `${domain}--2-clip.png`) : null;
  const baseHash = baseClip ? md5(baseClip) : null;
  const changed = !baseHash || baseHash !== md5(clip);

  rows.push({
    domain,
    kind: reviewKind(finding, clipState, castState),
    clipStale: clipState.stale,
    castStale: castState.stale,
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
// actually CHANGED since the baseline, then by state, then alphabetically.
// See the md5 helper above for why this replaced the composite ranking.
rows.sort((a, b) => {
  if (a.kind === 'blocked' && b.kind !== 'blocked') return -1;
  if (b.kind === 'blocked' && a.kind !== 'blocked') return 1;
  if (a.changed !== b.changed) return a.changed ? -1 : 1;
  const k = (KINDS[a.kind]?.rank ?? 9) - (KINDS[b.kind]?.rank ?? 9);
  if (k) return k;
  return a.domain.localeCompare(b.domain);
});

// ── Prune the review stamp of any surface whose image changed ───────
// Runs before any output so the counts printed below describe the file as it
// now stands. A stamp is only ever cleared when that surface's image
// demonstrably differs from the one reviewed, so a current review is never
// discarded.
//
// ONLY the stamp goes. verdict / severity / note / where are left intact:
// `where` is the reviewer's defect location (not ours to rewrite), and the note
// still describes the surface that did NOT change — which is exactly the
// context a partial re-review needs. An earlier version rewrote `where` and
// prefixed the note here, which mangled bloomberg's verdict across four runs.
let pruned = { clip: 0, cast: 0 };
if (pruneTargets.length && !noPrune) {
  const doc = existsSync(FINDINGS)
    ? JSON.parse(readFileSync(FINDINGS, 'utf8'))
    : { findings: {} };
  doc.findings ??= {};
  copyFileSync(FINDINGS, FINDINGS + '.bak');

  for (const t of pruneTargets) {
    const cur = doc.findings[t.domain];
    if (!cur) continue;
    if (t.clipStale) { cur.clipReviewedAt = null; pruned.clip++; }
    if (t.castStale) { cur.castReviewedAt = null; pruned.cast++; }
  }
  writeFileSync(FINDINGS, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

const blocked = rows.filter(r => r.kind === 'blocked');
const pendingRows = rows.filter(r => r.kind !== 'blocked');
const totalScored = readdirSync(RUN_DIR).filter(f => /--score\.json$/.test(f)).length;

if (asJson) {
  console.log(JSON.stringify({
    total: totalScored,
    pending: pendingRows.length,
    blocked: blocked.length,
    pruned,
    rows: rows.slice(0, limit),
  }, null, 2));
  process.exit(0);
}

console.log(`Sweep review queue — ${totalScored} captured · ${pendingRows.length} awaiting review · ${blocked.length} blocked`);
// Never prune silently: the file is the only record of ~200 hand-written
// verdicts, so a write must always be visible in the output that caused it.
// Never prune silently: the file is the only record of ~200 hand-written
// verdicts, so a write must always be visible in the output that caused it.
if (pruned.clip || pruned.cast) {
  console.log(`  cleared ${pruned.clip} clip + ${pruned.cast} cast review stamp(s) `
    + `— image changed since it was reviewed (notes kept)`);
}
if (noPrune && pruneTargets.length) {
  console.log(`  --no-prune: ${pruneTargets.length} domain(s) with a stale surface left untouched`);
}

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
    const tag = KINDS[r.kind]?.tag ?? '';
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
