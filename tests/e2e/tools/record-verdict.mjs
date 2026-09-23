#!/usr/bin/env node
// Write visual-review verdicts into corpus-sweep-run/visual-findings.json.
//
// Exists so verdicts are never written by an ad-hoc Python/jq round-trip: that
// file holds non-ASCII notes and has already been mojibaked once by an
// encoding-blind script ([[feedback_no_encoding_blind_json_scripts]]). This
// reads and writes UTF-8 explicitly, preserves `_comment`, and merges rather
// than replacing, so a partial update can't drop the other 200 verdicts.
//
// It also stamps `reviewedAt` (and `by`), plus a PER-SURFACE review stamp:
// `clipReviewedAt` / `castReviewedAt`, set for whichever surfaces this pass
// actually looked at. review-queue.mjs compares those against the capture's
// own `ranAt` to tell a current review from one predating a re-capture.
//
// TWO INDEPENDENT FIELDS, easily confused:
//   where    — where the DEFECT is (clip | cast | both). A reviewer routinely
//              reads both images and names the one with the problem, so this
//              says nothing about what was examined.
//   reviewed — which surfaces were EXAMINED (clip | cast | both, default both).
//              This is what drives the stamps.
// Reading `where` as coverage wrongly re-queues every domain whose defect was
// on one surface, and produced a bogus "[cast re-captured...]" note prefix.
//
// Usage — one domain:
//   node tests/e2e/tools/record-verdict.mjs bbc clean clip "Headline, hero and body captured cleanly."
//   node tests/e2e/tools/record-verdict.mjs imdb flaw clip "Cast list missing." --severity 4
//
// Usage — many at once (preferred while reviewing a batch; one atomic write):
//   node tests/e2e/tools/record-verdict.mjs --batch '[
//     {"domain":"bbc","verdict":"clean","where":"clip","note":"..."},
//     {"domain":"imdb","verdict":"flaw","where":"clip","note":"..."}
//   ]'
//   node tests/e2e/tools/record-verdict.mjs --batch-file verdicts.json
//
// verdict: clean | flaw | critical | blocked      where: clip | cast | both
//
// reviewed: clip | cast | both (default both) — which surfaces you LOOKED AT,
//   as opposed to `where`, which says where the defect is. Only needed when
//   re-checking one surface: `--reviewed cast` stamps the cast and leaves the
//   clip's existing review stamp alone.
//
// severity: 0-10, HOW BAD the capture is. The verdict is a coarse bucket; this
//   is the number to sort and trend on. Required for flaw/critical (a defect
//   with no magnitude cannot be prioritised), defaults to 0 for clean, and is
//   omitted for blocked (nothing was captured, so there is nothing to rate).
//
//   0     perfect — indistinguishable from the source's content column
//   1-2   cosmetic: spacing, a stray glyph, a slightly-off avatar
//   3-4   a real but minor loss: one missing byline, a dropped caption,
//         surviving chrome that a reader would scroll past
//   5-6   a substantive piece is wrong or missing: no hero, broken comment
//         thread, mangled stats row — still recognisably the right content
//   7-8   the clip misrepresents the page: wrong block captured, most of the
//         body absent, layout collapsed into unreadable columns
//   9-10  unusable: empty, or entirely the wrong content (a video rail, a
//         cookie wall, another post)
//
//   Rate what you SEE in the image, not what you infer about the cause, and
//   rate the worst of clip/cast — `where` already records which surface.
// regression: none | regressed | unknown  — is THIS capture worse than the
//   previous run's for the same domain? State it explicitly; 'unknown' (the
//   default) means nobody compared. A note for a `regressed` entry should say
//   what got worse.
// `by` defaults to 'ai'; pass --human for a verdict a person confirmed.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, '..', '..', '..', 'test-output');

const VERDICTS = new Set(['clean', 'flaw', 'critical', 'blocked']);
const WHERES = new Set(['clip', 'cast', 'both']);
// Whether this capture is WORSE than the previous run's for the same domain.
// Recorded explicitly rather than inferred from a score delta, because the
// composite is a weak proxy (the text-coverage flag is ~88% false positive on
// this corpus) and a verdict diff cannot tell a real regression from a baseline
// entry that was never checked against the image.
const REGRESSIONS = new Set(['none', 'regressed', 'unknown']);

// A verdict is three coarse buckets; severity is the magnitude inside them, and
// it is what the gallery sorts and badges on now that the computed composite is
// gone (it was measured anti-predictive — see sweepScorers.ts). Keeping the two
// consistent matters: a "flaw" rated 0 or a "clean" rated 6 is a typo, not a
// judgment, and silently accepting either would poison the only real ranking.
const SEVERITY_RANGE = { clean: [0, 2], flaw: [3, 7], critical: [6, 10] };

function severityFor(e) {
  if (e.verdict === 'blocked') return undefined;          // nothing captured to rate
  if (e.severity === undefined || e.severity === null) {
    if (e.verdict === 'clean') return 0;                  // the only safe default
    fail(`${e.domain}: verdict "${e.verdict}" requires --severity 0-10 `
      + `(3-7 flaw, 6-10 critical) — a defect with no magnitude cannot be ranked`);
  }
  const n = Number(e.severity);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    fail(`${e.domain}: severity must be an integer 0-10, got ${JSON.stringify(e.severity)}`);
  }
  const [lo, hi] = SEVERITY_RANGE[e.verdict] ?? [0, 10];
  if (n < lo || n > hi) {
    fail(`${e.domain}: severity ${n} contradicts verdict "${e.verdict}" `
      + `(expected ${lo}-${hi}) — change one or the other`);
  }
  return n;
}

const args = process.argv.slice(2);
const by = args.includes('--human') ? 'human' : 'ai';
const runDirIdx = args.indexOf('--run-dir');
// --run-dir (or SWEEP_RUN_DIR) writes into a BACKUP folder's own
// visual-findings.json instead of the live run's — used to verify a prior
// full run before trusting it as the regression baseline (review-queue.mjs
// takes the same flag; point both at the same folder).
const runDirArg = runDirIdx >= 0 ? args[runDirIdx + 1] : process.env.SWEEP_RUN_DIR;
const RUN_DIR = runDirArg
  ? (resolve(runDirArg) === runDirArg ? runDirArg : resolve(OUT_ROOT, runDirArg))
  : resolve(OUT_ROOT, 'corpus-sweep-run');
const FINDINGS = resolve(RUN_DIR, 'visual-findings.json');
const rest = args.filter((a, i) => a !== '--human' && a !== '--run-dir' && args[i - 1] !== '--run-dir');

function fail(msg) {
  console.error(`record-verdict: ${msg}`);
  process.exit(1);
}

let entries = [];
const batchIdx = rest.indexOf('--batch');
const batchFileIdx = rest.indexOf('--batch-file');

if (batchIdx >= 0) {
  const raw = rest[batchIdx + 1];
  if (!raw) fail('--batch needs a JSON array argument');
  entries = JSON.parse(raw);
} else if (batchFileIdx >= 0) {
  const p = rest[batchFileIdx + 1];
  if (!p) fail('--batch-file needs a path');
  entries = JSON.parse(readFileSync(p, 'utf8'));
} else {
  // Pull out every --flag VALUE pair first, so the note can't swallow one and
  // a flag's value can't be mistaken for a positional.
  const flagVal = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--severity' || rest[i] === '--reviewed') { flagVal[rest[i].slice(2)] = rest[++i]; }
    else positional.push(rest[i]);
  }
  const [domain, verdict, where, ...noteParts] = positional;
  if (!domain || !verdict) {
    fail('usage: record-verdict.mjs <domain> <verdict> [where] [note] [--severity N] [--reviewed clip|cast|both]');
  }
  entries = [{
    domain, verdict, where: where || 'clip', note: noteParts.join(' '),
    severity: flagVal.severity, reviewed: flagVal.reviewed,
  }];
}

if (!Array.isArray(entries) || entries.length === 0) fail('no verdict entries given');

// Validate names against the corpus. A typo ("bbc" for "bbc-news") otherwise
// silently ADDS a phantom domain rather than updating the real one: the verdict
// is lost, the real domain stays unreviewed, and nothing reports either.
const KNOWN = new Set(
  JSON.parse(readFileSync(
    resolve(__dirname, '..', '..', 'fixtures', 'corpus-domains.json'), 'utf8',
  )).domains.map(d => d.name),
);

for (const e of entries) {
  if (!e.domain) fail(`entry missing domain: ${JSON.stringify(e)}`);
  if (!KNOWN.has(e.domain)) {
    const near = [...KNOWN].filter(k => k.includes(e.domain) || e.domain.includes(k)).slice(0, 5);
    fail(`unknown domain "${e.domain}"${near.length ? ` — did you mean: ${near.join(', ')}?` : ''}`);
  }
  if (!VERDICTS.has(e.verdict)) fail(`bad verdict "${e.verdict}" for ${e.domain} (use ${[...VERDICTS].join('|')})`);
  severityFor(e);   // validate now so a bad batch fails before anything is written
  if (e.where && !WHERES.has(e.where)) fail(`bad where "${e.where}" for ${e.domain} (use ${[...WHERES].join('|')})`);
  if (e.reviewed && !WHERES.has(e.reviewed)) {
    fail(`bad reviewed "${e.reviewed}" for ${e.domain} (use ${[...WHERES].join('|')}) `
      + `— 'reviewed' is which surfaces you looked at, 'where' is where the defect is`);
  }
  if (e.regression && !REGRESSIONS.has(e.regression)) {
    fail(`bad regression "${e.regression}" for ${e.domain} (use ${[...REGRESSIONS].join('|')})`);
  }
  // A `regressed` verdict MUST state the delta separately from the general
  // note. Without this a reviewer blends "what changed" into one run-on
  // sentence with "what's wrong now", and the reader can't tell which part is
  // the regression claim — observed on target's first regression verdict:
  // the note opened with "REGRESSION:" but never isolated a before/after.
  if (e.regression === 'regressed' && !e.regressedFrom) {
    fail(`${e.domain}: regression:"regressed" requires regressedFrom — a short `
      + `"was X, now Y" statement of what changed, separate from the note`);
  }
  // One short sentence, per [[feedback_concise_sweep_verdicts]] — no dates, no
  // fix history. Warn rather than reject: a slightly long note beats losing it.
  if (e.note && e.note.length > 220) {
    console.warn(`  ! note for ${e.domain} is ${e.note.length} chars — keep verdicts to one sentence.`);
  }
}

let doc = { findings: {} };
if (existsSync(FINDINGS)) {
  doc = JSON.parse(readFileSync(FINDINGS, 'utf8'));
  // Single rolling backup — the file is the only record of ~200 hand-written
  // verdicts and is not in git (test-output/ is ignored).
  copyFileSync(FINDINGS, FINDINGS + '.bak');
}
doc.findings ??= {};

// Which surfaces this pass examined. Defaults to 'both', which is how review
// actually happens: read the clip and cast slices, then name the one with the
// defect in `where`. Pass reviewed:'cast' when re-checking a single surface.
function examined(e, surface) {
  const r = e.reviewed || 'both';
  return r === surface || r === 'both' || r === 'clip+cast';
}

// A single-surface re-review must not erase the other surface's stamp, which
// would read downstream as "never reviewed" and re-queue a surface verified
// minutes earlier. Carry the untouched one forward verbatim.
function keepStamp(domain, surface) {
  const prev = doc.findings[domain];
  const t = `${surface}ReviewedAt`;
  return prev && prev[t] !== undefined ? { [t]: prev[t] } : {};
}

// Local time WITH its UTC offset, e.g. 2026-09-17T12:04:01.816-07:00.
//
// A bare .toISOString() is UTC, and reading a UTC stamp beside a local file
// mtime inverts the comparison that decides staleness: cbc was reviewed at
// 12:04 local and re-captured at 15:27 local, but its UTC stamps (19:04 and
// 22:27) read as though the review came later. The offset makes the wall-clock
// time the reviewer remembers legible without losing the instant — Date.parse
// still yields the same moment, so comparisons against the sidecar's UTC
// `ranAt` are unaffected, and slice(0,10) now gives the LOCAL date.
function localStamp(d = new Date()) {
  const p = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${String(d.getMilliseconds()).padStart(3, '0')}`
    + `${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
}

const now = localStamp();
for (const e of entries) {
  const severity = severityFor(e);
  doc.findings[e.domain] = {
    verdict: e.verdict,
    // 0-10 magnitude; absent only for 'blocked'. See SEVERITY_RANGE above.
    ...(severity === undefined ? {} : { severity }),
    // Where the DEFECT is, as the reviewer stated it — stored verbatim, never
    // inferred from or conflated with which surfaces were examined.
    where: e.where || 'clip',
    // 'unknown' until a reviewer has actually compared against the prior run's
    // image — never silently defaulted to 'none', which would assert no
    // regression on evidence nobody gathered.
    regression: e.regression || 'unknown',
    // Structured "was X, now Y" — kept SEPARATE from `note` (which describes
    // the CURRENT state only, per the file's own convention) so a regression's
    // delta is never buried inside a general description.
    regressedFrom: e.regressedFrom || '',
    note: e.note || '',
    by: e.by || by,
    // Whole-entry stamp, kept for the gallery's REGRESSED tier (which asks
    // only "has this been reviewed at all").
    reviewedAt: now,
    // WHEN each surface was examined. Per-surface on purpose: after a
    // cast-only re-review a single shared timestamp would report the cast's
    // date as the clip's, so a clip unexamined for two sweeps reads as current.
    ...(examined(e, 'clip') ? { clipReviewedAt: now } : keepStamp(e.domain, 'clip')),
    ...(examined(e, 'cast') ? { castReviewedAt: now } : keepStamp(e.domain, 'cast')),
  };
}

writeFileSync(FINDINGS, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const counts = entries.reduce((m, e) => (m[e.verdict] = (m[e.verdict] ?? 0) + 1, m), {});
console.log(`Recorded ${entries.length} verdict(s) [${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}] by=${by}`);
for (const e of entries) {
  const sev = severityFor(e);
  console.log(`  ${e.verdict.padEnd(8)} ${sev === undefined ? '  -' : String(sev).padStart(2) + '/10'}  ${e.domain}`);
}
