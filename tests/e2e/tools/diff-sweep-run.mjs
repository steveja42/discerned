#!/usr/bin/env node
// Compare a freshly-completed corpus-sweep-run/ against a prior backup folder
// (see backup-sweep-run.mjs), so a reviewer spends attention on what actually
// CHANGED instead of re-eyeballing 200+ unchanged domains after every run.
//
// A byte-identical PNG means the pipeline produced pixel-for-pixel the same
// output — safe to skip. A changed PNG doesn't say GOOD or BAD, only DIFFERENT;
// a human (or Claude) still has to look. Score deltas are reported alongside
// so "changed AND got worse" sorts to the top.
//
// Usage:
//   node tests/e2e/tools/diff-sweep-run.mjs <backup-dir> [--json]
// Default text output is a ranked list; --json emits the same data as JSON for
// a caller that wants to filter/sort further.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const backupArg = args.find(a => !a.startsWith('--'));

const OUT_ROOT = resolve(import.meta.dirname, '..', '..', '..', 'test-output');
const CURRENT = resolve(OUT_ROOT, 'corpus-sweep-run');

if (!backupArg) {
  console.error('Usage: node diff-sweep-run.mjs <backup-dir> [--json]');
  console.error('Available backups:');
  for (const d of readdirSync(OUT_ROOT)) {
    if (d.startsWith('corpus-sweep-run--backup-')) console.error('  ' + d);
  }
  process.exit(1);
}
const BACKUP = /^[A-Za-z]:[\/]/.test(backupArg) || backupArg.startsWith('/')
  ? backupArg
  : resolve(OUT_ROOT, backupArg);

if (!existsSync(BACKUP)) {
  console.error(`Backup dir not found: ${BACKUP}`);
  process.exit(1);
}
if (!existsSync(CURRENT)) {
  console.error(`No current run at: ${CURRENT}`);
  process.exit(1);
}

function sha1(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function domainsIn(dir) {
  const names = new Set();
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(.+)--(?:1-source|2-clip|3-cast|score)\.(?:png|json)$/);
    if (m) names.add(m[1]);
  }
  return names;
}

const domains = new Set([...domainsIn(CURRENT), ...domainsIn(BACKUP)]);
const IMG_KINDS = ['1-source', '2-clip', '3-cast'];

const results = [];
for (const domain of [...domains].sort()) {
  const curScorePath = resolve(CURRENT, `${domain}--score.json`);
  const bakScorePath = resolve(BACKUP, `${domain}--score.json`);
  const curScore = existsSync(curScorePath) ? JSON.parse(readFileSync(curScorePath, 'utf8')) : null;
  const bakScore = existsSync(bakScorePath) ? JSON.parse(readFileSync(bakScorePath, 'utf8')) : null;

  const imageDiffs = {};
  let anyImageChanged = false;
  let anyImageNew = false;
  let anyImageMissing = false;
  for (const kind of IMG_KINDS) {
    const curPath = resolve(CURRENT, `${domain}--${kind}.png`);
    const bakPath = resolve(BACKUP, `${domain}--${kind}.png`);
    const curExists = existsSync(curPath);
    const bakExists = existsSync(bakPath);
    if (curExists && bakExists) {
      const same = sha1(curPath) === sha1(bakPath);
      imageDiffs[kind] = same ? 'same' : 'changed';
      if (!same) anyImageChanged = true;
    } else if (curExists && !bakExists) {
      imageDiffs[kind] = 'new';
      anyImageNew = true;
    } else if (!curExists && bakExists) {
      imageDiffs[kind] = 'missing'; // this run didn't produce it (regression or new skip)
      anyImageMissing = true;
    } else {
      imageDiffs[kind] = 'absent'; // neither run has it (n/a domain, e.g. no cast)
    }
  }

  const curComposite = curScore?.scores?.composite ?? null;
  const bakComposite = bakScore?.scores?.composite ?? null;
  const compositeDelta = (curComposite !== null && bakComposite !== null)
    ? +(curComposite - bakComposite).toFixed(3)
    : null;
  const statusChanged = (curScore?.status ?? 'missing') !== (bakScore?.status ?? 'missing');

  const changed = anyImageChanged || anyImageNew || anyImageMissing || statusChanged
    || (compositeDelta !== null && Math.abs(compositeDelta) > 0.001);

  results.push({
    domain,
    changed,
    curStatus: curScore?.status ?? 'missing',
    bakStatus: bakScore?.status ?? 'missing',
    curComposite, bakComposite, compositeDelta,
    curFlags: curScore?.scores?.flags ?? [],
    images: imageDiffs,
    regressedToSkip: (bakScore?.status === 'ok' && curScore?.status !== 'ok'),
    newlyOk: (bakScore?.status !== 'ok' && curScore?.status === 'ok'),
  });
}

// Rank: regressions-to-skip first, then worsened composite, then other changes,
// then unchanged. Within "changed", worse composite delta (higher = worse, per
// the sweep's own convention) sorts first.
results.sort((a, b) => {
  if (a.regressedToSkip !== b.regressedToSkip) return a.regressedToSkip ? -1 : 1;
  if (a.changed !== b.changed) return a.changed ? -1 : 1;
  const ad = a.compositeDelta ?? 0, bd = b.compositeDelta ?? 0;
  return bd - ad;
});

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const changedCount = results.filter(r => r.changed).length;
  const unchangedCount = results.length - changedCount;
  console.log(`\n${results.length} domains compared: ${changedCount} changed, ${unchangedCount} unchanged\n`);
  console.log('backup:  ' + basename(BACKUP));
  console.log('current: corpus-sweep-run\n');
  for (const r of results) {
    if (!r.changed) continue;
    const tag = r.regressedToSkip ? 'REGRESSED->SKIP'
      : r.newlyOk ? 'NEWLY-OK'
      : r.compositeDelta !== null && r.compositeDelta > 0.01 ? 'WORSE'
      : r.compositeDelta !== null && r.compositeDelta < -0.01 ? 'BETTER'
      : 'CHANGED';
    const deltaStr = r.compositeDelta !== null ? ` Δ${r.compositeDelta >= 0 ? '+' : ''}${r.compositeDelta}` : '';
    const imgStr = IMG_KINDS.map(k => `${k}=${r.images[k]}`).join(' ');
    console.log(`[${tag.padEnd(16)}] ${r.domain.padEnd(22)}${deltaStr.padEnd(9)} ${imgStr}`);
  }
}
