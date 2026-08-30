#!/usr/bin/env node
// List domains whose score.json landed AFTER a given epoch-seconds cutoff —
// i.e. genuinely fresh from the run in progress, not a leftover from a
// previous run that happens to still be sitting in corpus-sweep-run/.
//
// Usage: node tests/e2e/tools/watch-sweep-run.mjs <sinceEpochSeconds>
// Prints one line per newly-landed domain, oldest first: "<domain> <status> <composite|-> <mtimeIso>"

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const since = Number(process.argv[2]);
if (!since) {
  console.error('Usage: node watch-sweep-run.mjs <sinceEpochSeconds>');
  process.exit(1);
}

const DIR = resolve(import.meta.dirname, '..', '..', '..', 'test-output', 'corpus-sweep-run');
const rows = [];
for (const f of readdirSync(DIR)) {
  const m = f.match(/^(.+)--score\.json$/);
  if (!m) continue;
  const full = resolve(DIR, f);
  const st = statSync(full);
  const mtimeSec = st.mtimeMs / 1000;
  if (mtimeSec <= since) continue;
  let status = '?', composite = '-';
  try {
    const rec = JSON.parse(readFileSync(full, 'utf8'));
    status = rec.status ?? '?';
    composite = rec.scores?.composite ?? '-';
  } catch { /* mid-write, skip this poll */ }
  rows.push({ domain: m[1], status, composite, mtime: mtimeSec });
}
rows.sort((a, b) => a.mtime - b.mtime);
for (const r of rows) {
  console.log(`${r.domain}\t${r.status}\t${r.composite}\t${new Date(r.mtime * 1000).toISOString()}`);
}
if (rows.length === 0) console.error(`(no domains landed since ${new Date(since * 1000).toISOString()})`);
