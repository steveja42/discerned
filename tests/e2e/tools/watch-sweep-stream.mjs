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

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = resolve(__dirname, '..', '..', '..', 'test-output', 'corpus-sweep-run');
const CORPUS = resolve(__dirname, '..', '..', 'fixtures', 'corpus-domains.json');
const SLICER = resolve(__dirname, 'slice-clip.py');
const PYTHON = process.env.PYTHON ?? 'python3';

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
const announced = new Set();

/** @type {{domain:string, composite:number, flags:string[], hasCast:boolean}[]} */
let sliceQueue = [];

/** Slice everything queued, then announce each with its SLICED paths — the
 *  paths a reviewer (or Claude, via Read) can open and actually see text in. */
function flushSliceQueue() {
  if (!sliceQueue.length) return;
  const batch = sliceQueue;
  sliceQueue = [];
  sliceBatch(batch.map(b => b.domain));
  for (const b of batch) {
    const flagsStr = b.flags.length ? ` [${b.flags.join('; ')}]` : '';
    const castNote = b.hasCast ? '' : ' (no cast image)';
    console.log(`READY ${b.domain} composite=${b.composite.toFixed(3)}${flagsStr}${castNote}`);
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
        composite: rec.scores?.composite ?? 0,
        flags: rec.scores?.flags ?? [],
        hasCast: existsSync(cast),
      });
    } else {
      announced.add(domain);
      console.log(`SKIP  ${domain} — ${String(rec.skipReason ?? '').slice(0, 90)}`);
    }
  }

  // Flush once a full batch is queued, OR the run just finished (so the last
  // partial batch — fewer than SLICE_BATCH domains — doesn't sit unsliced).
  const done = announced.size >= total;
  if (sliceQueue.length >= SLICE_BATCH || (done && sliceQueue.length)) flushSliceQueue();

  if (done) {
    console.log(`DONE — all ${total} corpus domains accounted for.`);
    process.exit(0);
  }
}

poll();
setInterval(poll, 5_000);
