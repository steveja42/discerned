#!/usr/bin/env node
// Emit ONE LINE per domain as the sweep finishes it — an event stream for the
// Monitor tool, so review is driven by notifications instead of polling.
//
// The difference matters: polling `watch-sweep-run.mjs` costs a turn per check,
// and those turns displace the reviewing they were meant to enable. This prints
// a line the moment a domain's score.json AND its images are on disk, so each
// notification is an actionable "this one is ready to eyeball" with the paths
// already resolved.
//
// Each line also says whether the domain NEEDS review, via the shared rule in
// lib/review-state.mjs:
//
//   READY <domain> … [NOT REVIEWED — clip and cast]   <- open these, verdict it
//     clip 1: …/slices/<domain>--slice-1.png
//   OK    <domain> … — verdict current                 <- sliced, nothing to do
//
// Without that tag this stream is only a TIMING signal — it announces every
// captured domain — so a reviewer working straight from the log re-reviews the
// whole corpus, which is exactly what the staleness rule exists to prevent.
// Everything is sliced either way: slices must stay current whether or not
// anyone opens them, since a stale band beside a fresh PNG reads as current.
//
// The tag is a SNAPSHOT from when the domain landed. If Pass-2 re-captures it
// later, an earlier line in the scrollback is stale text — review-queue.mjs
// remains the authoritative "what is outstanding right now", and is what you
// use to resume review in a later session (this watcher exits at DONE).
//
// Waits for the CAST png too, not just the clip: the cast is written after the
// clip, and a clip-only trigger produces a notification for a domain whose cast
// image does not exist yet — which is precisely how a review ends up
// clip-only. Both must be present before a domain is announced.
//
// Usage (via Monitor):
//   node tests/e2e/tools/watch-sweep-stream.mjs [--since <epochSeconds>] [--only d1,d2]
// --only (or $SWEEP_ONLY) scopes to a subset — MUST match the sweep's own
// SWEEP_ONLY for a resume/scoped run, or `total` is wrong (see below).
// Exits when every TARGETED domain has landed, so the watch ends on its own.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// The staleness rule is SHARED with review-queue.mjs — see that module's header
// for why the two must never carry separate copies of it.
import { findBaselineDir, domainReviewState, KINDS } from './lib/review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, '..', '..', '..', 'test-output');
const RUN_DIR = resolve(OUT_ROOT, 'corpus-sweep-run');
const CORPUS = resolve(__dirname, '..', '..', 'fixtures', 'corpus-domains.json');
const SLICER = resolve(__dirname, 'slice-clip.py');
const QUEUE = resolve(__dirname, 'review-queue.mjs');
const PYTHON = process.env.PYTHON ?? 'python3';

// Resolved once: a sweep does not create backups mid-run, so re-scanning the
// folder per domain would buy nothing.
const baselineDir = findBaselineDir(OUT_ROOT);

/**
 * Slice a BATCH of domains' clip + cast top bands in one call — this is what
 * makes "review in parallel with capture" actually work end to end, not just
 * "watch progress" end to end. Without it, a Monitor notification names a
 * domain whose image is still a raw ~8000px PNG that downscales ~4x on read
 * (illegible text), so a reviewer either reads a smear or has to run
 * slice-clip.py by hand for every announcement — exactly the manual step this
 * script exists to remove.
 *
 * slice-clip.py is a plain Pillow crop (~0.3s per domain, no browser) — an
 * earlier version shelled out to a Chromium-based slicer, which was needless
 * weight for cropping an already-rendered PNG (discerned-ext/CLAUDE.md's own
 * refresh-gallery.py had already established the Pillow-crop pattern; the
 * Chromium version should never have been built). Batching is kept anyway: it
 * groups log output into one line per burst instead of one per domain, and
 * costs nothing extra now that there's no browser startup to amortize.
 */
function sliceBatch(domains) {
  if (!domains.length) return;
  const arg = domains.join(',');
  for (const args of [[arg], [arg, '--cast']]) {
    try { spawnSync(PYTHON, [SLICER, ...args], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
}
const SLICE_BATCH = Number(process.env.SLICE_BATCH ?? 5);

const sinceArg = process.argv.indexOf('--since');
const since = sinceArg >= 0 ? Number(process.argv[sinceArg + 1]) * 1000 : 0;
// SWEEP_ONLY mirrors the sweep's own domain filter: a scoped run (SWEEP_ONLY,
// a -Resume pass, a 3-domain smoke test) is watching for only THOSE domains,
// not the full corpus. Without this, `total` = 206 and pre-existing sidecars
// older than --since immediately satisfy "everything accounted for", so the
// watcher printed DONE instantly on a 3-domain run before any of the 3 had
// even started — announced.size hit 203 from stale sidecars alone.
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : process.env.SWEEP_ONLY;

const allDomains = JSON.parse(readFileSync(CORPUS, 'utf8')).domains.map(d => d.name);
const target = only
  ? new Set(only.split(',').map(s => s.trim()).filter(Boolean))
  : new Set(allDomains);
const total = target.size;
// Domains whose CAPTURE has been announced (status ok). This is what the exit
// condition counts — see the skip branch below for why a skip must not.
const announced = new Set();
// Domains already reported as skipped, so the line prints once per domain
// without retiring it from `announced`.
const skipAnnounced = new Set();
// A run is only finished once every domain is accounted for AND nothing new has
// been announced for this long — a walled domain can be retried minutes later.
const QUIET_MS = Number(process.env.SWEEP_WATCH_QUIET_MS ?? 180_000);
let lastAccounted = 0;
let lastProgressAt = Date.now();

/** @type {{domain:string, cov:number, chromeHits:number, hasCast:boolean, rec:object}[]} */
let sliceQueue = [];

/** Current verdicts. Re-read per flush, not cached: the reviewer is recording
 *  verdicts WHILE this runs, so a cached copy would announce a domain as
 *  needing review seconds after it was reviewed. */
function loadFindings() {
  try {
    return JSON.parse(readFileSync(resolve(RUN_DIR, 'visual-findings.json'), 'utf8')).findings ?? {};
  } catch {
    return {};
  }
}

/** Slice everything queued, then announce each with its SLICED paths — the
 *  paths a reviewer (or Claude, via Read) can open and actually see text in.
 *
 *  Each line also says whether the domain actually NEEDS review, using the same
 *  rule review-queue.mjs applies. Without it this stream is only a timing
 *  signal: it announces every captured domain, so a reviewer working straight
 *  from the log re-reviews the whole corpus — exactly what the staleness rule
 *  exists to prevent. Everything is still sliced either way, because slices
 *  must stay current regardless of whether anyone opens them (a stale band
 *  beside a fresh PNG is the politico-92h failure). */
function flushSliceQueue() {
  if (!sliceQueue.length) return;
  const batch = sliceQueue;
  sliceQueue = [];
  sliceBatch(batch.map(b => b.domain));
  const findings = loadFindings();
  for (const b of batch) {
    // Diagnostics only — there is no quality score to print. Ranking by the old
    // composite was measured anti-predictive, so a number here would just tell
    // the reviewer which image to prejudge.
    const diag = `cov=${(b.cov * 100).toFixed(0)}%` + (b.chromeHits ? ` chrome=${b.chromeHits}` : '');
    const castNote = b.hasCast ? '' : ' (no cast image)';
    const { pending, kind } = domainReviewState({
      runDir: RUN_DIR, domain: b.domain, finding: findings[b.domain], rec: b.rec, baselineDir,
    });

    if (!pending) {
      // Sliced and current — say so on one line and print no paths, so the log
      // stays a complete record of the run without inviting a needless read.
      console.log(`OK    ${b.domain} ${diag}${castNote} — verdict current`);
      continue;
    }

    console.log(`READY ${b.domain} ${diag}${castNote}${KINDS[kind]?.tag ?? ''}`);
    // Announce EVERY band the slicer wrote, not just band 1. slice-clip.py
    // defaults to 3 bands because content buried under prepended chrome (a
    // video rail, an expanded carousel) does not reach band 1 — announcing
    // only the first would put the reviewer right back in front of the
    // partial view the default exists to fix.
    for (const [label, suffix] of [['clip', 'slice'], ['cast', 'castslice']]) {
      for (let i = 1; ; i++) {
        const p = resolve(RUN_DIR, 'slices', `${b.domain}--${suffix}-${i}.png`);
        if (!existsSync(p)) break;
        console.log(`  ${label} ${i}: ${p}`);
      }
    }
  }
}

function poll() {
  let files;
  try { files = readdirSync(RUN_DIR); } catch { return; }

  for (const f of files) {
    const m = f.match(/^(.+)--score\.json$/);
    if (!m) continue;
    const domain = m[1];
    if (announced.has(domain)) continue;
    if (!target.has(domain)) continue; // outside the scoped run — not ours to announce

    const scorePath = resolve(RUN_DIR, f);
    let st, rec;
    try {
      st = statSync(scorePath);
      rec = JSON.parse(readFileSync(scorePath, 'utf8'));
    } catch { continue; } // mid-write; try again next tick

    // Filter on the record's OWN ranAt, not the file mtime: the mtime moves
    // whenever anything rewrites the folder, so an mtime filter re-announces
    // domains captured hours ago.
    //
    // Do NOT mark `announced` here. A stale sidecar means "not yet re-captured
    // THIS POLL" — on a scoped/resume run the sweep is actively about to
    // overwrite this exact file with a fresh one, and marking it announced now
    // means the fresh capture is silently never reported when it lands a few
    // seconds later. Observed: a 3-domain smoke test printed DONE instantly
    // with zero READY lines, because all 3 sidecars predated `since` on the
    // very first poll (before the sweep had written anything) and were
    // permanently written off. Just skip this poll; check again next tick.
    if (since && rec.ranAt && Date.parse(rec.ranAt) < since) continue;

    if (rec.status === 'ok') {
      // Only queue once BOTH images exist — see header. A cast can be
      // legitimately absent (castShotSafe swallows a flaky render), so give it
      // a grace period rather than waiting forever.
      const clip = resolve(RUN_DIR, `${domain}--2-clip.png`);
      const cast = resolve(RUN_DIR, `${domain}--3-cast.png`);
      const ageMs = Date.now() - st.mtimeMs;
      if (!existsSync(clip)) continue;
      if (!existsSync(cast) && ageMs < 45_000) continue;

      announced.add(domain);
      sliceQueue.push({
        domain,
        cov: rec.scores?.textCoverage ?? 0,
        chromeHits: rec.scores?.chromeHits ?? 0,
        hasCast: existsSync(cast),
        rec,   // the staleness rule needs this capture's own ranAt
      });
    } else {
      // Announce a skip ONCE, but do not let it retire the domain: the sweep's
      // Pass-2 retry can still capture it, and a skip that counted toward the
      // exit condition made the watcher finish early. Measured 2026-09-15: 14
      // walled domains skipped, announced.size hit 206 while seven domains were
      // still being captured, and DONE fired at 00:40 on a run that ended at
      // 08:00 — those seven landed with no watcher and were never sliced, so
      // their review slices silently described the PREVIOUS run's images.
      if (!skipAnnounced.has(domain)) {
        skipAnnounced.add(domain);
        console.log(`SKIP  ${domain} — ${String(rec.skipReason ?? '').slice(0, 90)}`);
      }
    }
  }

  // Every domain must be accounted for — captured OR skipped. A skip alone is
  // not enough to finish, because the sweep's Pass-2 retry may still capture
  // it; so also require a QUIET PERIOD with no new announcement, which is what
  // actually proves the sweep has stopped. Without the quiet period a run whose
  // last domains are walled would exit while they were still being retried.
  const accounted = new Set([...announced, ...skipAnnounced]).size >= total;
  if (announced.size + skipAnnounced.size > lastAccounted) {
    lastAccounted = announced.size + skipAnnounced.size;
    lastProgressAt = Date.now();
  }
  const quiet = Date.now() - lastProgressAt >= QUIET_MS;
  const done = accounted && quiet;

  // Flush once a full batch is queued, OR the run just finished (so the last
  // partial batch — fewer than SLICE_BATCH domains — doesn't sit unsliced).
  if (sliceQueue.length >= SLICE_BATCH || (done && sliceQueue.length)) flushSliceQueue();

  if (done) {
    finishRun();
    console.log(`DONE — all ${total} corpus domains accounted for `
      + `(${announced.size} captured, ${skipAnnounced.size} skipped).`);
    process.exit(0);
  }
}

/**
 * End-of-run housekeeping. This watcher is the only thing that knows when a
 * BACKGROUND sweep has actually finished — corpus-sweep-run.ps1 detaches and
 * exits immediately, so it cannot do this itself (the -Foreground and -Attended
 * paths run the same two steps inline).
 *
 * 1. Catch up any stale slices. Domains are sliced as they land, but a Pass-2
 *    retry that lands after this watcher last flushed — or a domain captured
 *    while the watcher was down — keeps bands older than its PNG, which review
 *    then reads as current (measured: 92h stale beside a fresh clip).
 * 2. Run review-queue.mjs once, which PRUNES stale review stamps. That is the
 *    only writer; this watcher stays read-only so it can never race a
 *    record-verdict.mjs write happening in the review session.
 *
 * Best-effort throughout: a failure here must not lose the DONE line, which is
 * what the review session is waiting on.
 */
function finishRun() {
  try {
    for (const args of [['--all', '--stale-only'], ['--all', '--stale-only', '--cast']]) {
      spawnSync(PYTHON, [SLICER, ...args], { stdio: 'ignore' });
    }
  } catch { /* best effort */ }
  try {
    const r = spawnSync(process.execPath, [QUEUE, '--stats'], { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
  } catch { /* best effort */ }
}

poll();
setInterval(poll, 5_000);
