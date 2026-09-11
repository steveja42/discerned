#!/usr/bin/env node
// Write visual-review verdicts into corpus-sweep-run/visual-findings.json.
//
// Exists so verdicts are never written by an ad-hoc Python/jq round-trip: that
// file holds non-ASCII notes and has already been mojibaked once by an
// encoding-blind script ([[feedback_no_encoding_blind_json_scripts]]). This
// reads and writes UTF-8 explicitly, preserves `_comment`, and merges rather
// than replacing, so a partial update can't drop the other 200 verdicts.
//
// It also stamps `reviewedAt` (and `by`), which is what lets review-queue.mjs
// tell a CURRENT verdict from one describing a since-re-captured image.
//
// Usage — one domain:
//   node tests/e2e/tools/record-verdict.mjs bbc clean clip "Headline, hero and body captured cleanly."
//
// Usage — many at once (preferred while reviewing a batch; one atomic write):
//   node tests/e2e/tools/record-verdict.mjs --batch '[
//     {"domain":"bbc","verdict":"clean","where":"clip","note":"..."},
//     {"domain":"imdb","verdict":"flaw","where":"clip","note":"..."}
//   ]'
//   node tests/e2e/tools/record-verdict.mjs --batch-file verdicts.json
//
// verdict: clean | flaw | critical | blocked      where: clip | cast | both
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
  const [domain, verdict, where, ...noteParts] = rest;
  if (!domain || !verdict) fail('usage: record-verdict.mjs <domain> <verdict> [where] [note]');
  entries = [{ domain, verdict, where: where || 'clip', note: noteParts.join(' ') }];
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
  if (e.where && !WHERES.has(e.where)) fail(`bad where "${e.where}" for ${e.domain} (use ${[...WHERES].join('|')})`);
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

const now = new Date().toISOString();
for (const e of entries) {
  doc.findings[e.domain] = {
    verdict: e.verdict,
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
    reviewedAt: now,
  };
}

writeFileSync(FINDINGS, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const counts = entries.reduce((m, e) => (m[e.verdict] = (m[e.verdict] ?? 0) + 1, m), {});
console.log(`Recorded ${entries.length} verdict(s) [${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}] by=${by}`);
for (const e of entries) console.log(`  ${e.verdict.padEnd(8)} ${e.domain}`);
