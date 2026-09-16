#!/usr/bin/env node
// Phase 4.1 — builds test-output/corpus-sweep-run/sweep-gallery.html: a review
// page for the broad-web corpus sweep. Same interaction model as the live Visual
// Test Gallery (tools/live-gallery.mjs): an OVERVIEW list of clickable rows (each
// a compact three-panel source|clip|cast preview + score badge + flags), and a
// full-page DETAIL view per domain (opened by clicking its row / its #hash) where
// the page scrollbar or a wheel gesture scrolls all three panels TOGETHER 1:1,
// while each panel's own scrollbar still nudges just that one for alignment — the
// exact scroll behavior of live-gallery's detail view.
//
// On top of that shared model the sweep keeps its own extras: a severity badge
// badge, the tripped-heuristic flags + raw metrics line, worst-score-first /
// newest-run-first sorting, an "only flagged" filter, and compact skip rows.
//
// Reads {domain}--score.json (status/scores/ranAt) + {domain}--{1,2,3}-*.png.
//
// Run standalone:  node tests/e2e/tools/sweep-gallery.mjs [--open]

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(__dirname, '..', '..', '..', 'test-output');

/**
 * md5 of a clip PNG, or null when it does not exist. Used to prove a capture
 * is byte-identical across runs, which outranks any verdict diff.
 */
function clipHash(p) {
  try { return createHash('md5').update(readFileSync(p)).digest('hex'); }
  catch { return null; }
}


// --run-dir (or SWEEP_RUN_DIR) builds the gallery for a BACKUP folder instead
// of the live run — the same flag review-queue.mjs, record-verdict.mjs and
// slice-clip.py already take. Needed so a REGRESSED card can link to the
// baseline's own gallery: without a built gallery on the other side there is
// nothing to link TO, and the reviewer is left diffing two folders by hand.
// Guard the index explicitly — `indexOf(...) + 1` reads args[0] as the value
// when the flag is absent (the bug review-queue.mjs documents).
const rdIdx = process.argv.indexOf('--run-dir');
const rdArg = rdIdx >= 0 ? process.argv[rdIdx + 1] : process.env.SWEEP_RUN_DIR;
const RUN_DIR = rdArg
  ? (resolve(rdArg) === rdArg ? rdArg : resolve(OUT_ROOT, rdArg))
  : resolve(OUT_ROOT, 'corpus-sweep-run');
const OUT = resolve(RUN_DIR, 'sweep-gallery.html');

const IMG_RE = /^(.+?)--(\d+)-(source|clip|cast)(?:-([a-z]+))?\.png$/;

function build() {
  let files;
  try { files = readdirSync(RUN_DIR); } catch { return null; }

  // Per-file mtimes drive a `?v=<mtime>` cache-buster on every <img src> so a
  // reload of the gallery always fetches the FRESHLY-regenerated PNG. Filenames
  // are stable ({domain}--3-cast.png), so without this the browser serves the
  // cached bytes of a prior run even on a hard reload — the reported "Axios cast
  // doesn't match the current one" symptom.
  /** @type {Map<string, number>} filename → mtimeMs */
  const fileMtimes = new Map();

  /** @type {Map<string, {source: string[], clip: string[], cast: string[], mtime: number, rec: any}>} */
  const sites = new Map();
  const ensure = (s) => { if (!sites.has(s)) sites.set(s, { source: [], clip: [], cast: [], mtime: 0, rec: null }); return sites.get(s); };

  for (const f of files) {
    const m = IMG_RE.exec(f);
    if (!m) continue;
    const [, site, , type, variant] = m;
    if (variant) continue; // skip crop variants in the gallery
    const e = ensure(site);
    e[type].push(f);
    try {
      const mt = statSync(resolve(RUN_DIR, f)).mtimeMs;
      fileMtimes.set(f, mt);
      e.mtime = Math.max(e.mtime, mt);
    } catch { /* ignore */ }
  }

  // Cache-busting src: append `?v=<mtimeMs>` so a regenerated image (same
  // filename) gets a new URL the browser can't serve stale from cache.
  const src = (f) => `./${f}?v=${Math.round(fileMtimes.get(f) ?? 0)}`;
  // Merge score.json sidecars.
  for (const f of files) {
    const m = /^(.+?)--score\.json$/.exec(f);
    if (!m) continue;
    try {
      const rec = JSON.parse(readFileSync(resolve(RUN_DIR, f), 'utf8'));
      const e = ensure(m[1]);
      e.rec = rec;
      const t = rec.ranAt ? Date.parse(rec.ranAt) : NaN;
      if (!Number.isNaN(t)) e.mtime = Math.max(e.mtime, t);
    } catch { /* ignore malformed */ }
  }
  if (sites.size === 0) return null;

  // Human visual-review verdicts (visual-findings.json) — merged in + sortable.
  // Kept separate from the auto-scored *--score.json so a re-run never clobbers
  // them. worst→best rank so "sort by finding" surfaces the real problems first.
  // `clean`/`flaw`/`critical` are judgments on OUR clipping pipeline — this
  // includes a paywalled page where we faithfully captured everything visible
  // up to the gate (that's `clean`: nothing our pipeline could have done
  // differently short of bypassing the paywall). `blocked` is NOT a pipeline
  // judgment — it means we never reached real page content at all (bot-wall
  // interstitial, 403, dead/404 URL, rate-limit stub), so there is nothing to
  // evaluate visually. Ranked last so permanently-walled domains don't squat
  // the top of the "sort by finding" view, where actionable flaws belong.
  const VERDICT_RANK = { critical: 0, flaw: 1, clean: 2, blocked: 3 };
  let findings = {};
  try {
    findings = JSON.parse(readFileSync(resolve(RUN_DIR, 'visual-findings.json'), 'utf8')).findings ?? {};
  } catch { /* no findings file yet */ }

  // ── Regression data: this run vs the most recent backup ──────────────────
  // A sweep's most actionable signal is not "which domain scores worst" (the
  // scorer's worst decile is dominated by text-heavy false positives) but
  // "which domain got WORSE since last time". That needs the previous run's
  // sidecars, which backup-sweep-run.mjs snapshots before each sweep.
  // Uses the module-level OUT_ROOT (test-output/), not resolve(RUN_DIR,'..'):
  // with --run-dir pointing at an absolute path outside test-output/, the
  // relative form would look for backups in the wrong parent.
  let prev = {};
  let prevLabel = '';
  let prevIsMerged = false;
  let prevFindings = {};
  const prevSameImage = new Set();
  try {
    const backups = readdirSync(OUT_ROOT)
      .filter(d => d.startsWith('corpus-sweep-run--backup-'))
      .sort(); // stamped YYYY-MM-DDTHH-mm-ss → lexical order is chronological
    if (backups.length) {
      // Baseline = the most recent FULL-CORPUS backup, not simply the newest.
      //
      // Every sweep takes a backup on the way in, including the short recovery
      // and single-domain runs, so "newest" is usually a snapshot of a partly
      // re-run corpus taken minutes ago — comparing against that reports
      // yesterday's recoveries as today's breakages (measured: librarything,
      // rateyourmusic, netflix-techblog etc. all read as "broke" purely because
      // the same-day baseline had inherited their captures from an older run).
      // A run is "full" if it holds a sidecar for (nearly) every corpus domain
      // AND those sidecars share one run window, so a merged folder that
      // accumulated coverage over weeks does not qualify.
      // SWEEP_BASELINE=<folder-name> overrides. The label is rendered in the
      // toolbar so the comparison is never ambiguous.
      const totalDomains = sites.size;
      // A backup qualifies when MOST of its sidecars share one run window — not
      // when its outer span is short. A real full run picks up a few stragglers
      // afterwards (a recovery pass, a one-off re-capture), which stretches the
      // outer span to weeks while the run itself was a single day. Measured on
      // the 2026-09-05 backup: 202 of 206 domains captured inside one 16h window
      // on 2026-08-30, plus 4 re-captured on 09-05 — outer span 159h. An
      // outer-span test rejected it as "merged" and fell back to a worse
      // baseline; a dominant-cohort test accepts it correctly.
      const isFullRun = (name) => {
        try {
          const files = readdirSync(resolve(OUT_ROOT, name)).filter(f => /--score\.json$/.test(f));
          if (files.length < totalDomains * 0.9) return false;
          const times = [];
          for (const f of files) {
            try {
              const t = Date.parse(JSON.parse(readFileSync(resolve(OUT_ROOT, name, f), 'utf8')).ranAt);
              if (!Number.isNaN(t)) times.push(t);
            } catch { /* skip */ }
          }
          if (times.length < 10) return false;
          times.sort((a, b) => a - b);
          // Largest count of sidecars falling inside any 24h window.
          let best = 0;
          for (let i = 0; i < times.length; i++) {
            let j = i;
            while (j < times.length && times[j] - times[i] <= 24 * 3_600_000) j++;
            best = Math.max(best, j - i);
          }
          return best >= times.length * 0.8;
        } catch { return false; }
      };
      const override = process.env.SWEEP_BASELINE;
      const fullRun = [...backups].reverse().find(isFullRun);
      prevLabel = override && backups.includes(override)
        ? override
        : (fullRun ?? backups[backups.length - 1]);
      // Flag a merged baseline in the UI. Measured 2026-09-08: BOTH backups on
      // disk span 159h and 300h, i.e. neither is a single full run — each
      // accumulated coverage across many partial runs. Comparing against one
      // still beats nothing, but a "broke" there can mean "this domain was last
      // captured three weeks ago and has been failing since", which is a
      // different claim from "this run broke it". Say so rather than implying a
      // clean run-over-run diff.
      prevIsMerged = !override && !fullRun;
      const dir = resolve(OUT_ROOT, prevLabel);
      for (const f of readdirSync(dir)) {
        const m = f.match(/^(.+)--score\.json$/);
        if (!m) continue;
        try { prev[m[1]] = JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { /* skip */ }
      }
      // The baseline's VISUAL VERDICTS, which outrank its scores as a regression
      // signal. The composite is a weak proxy — measured this corpus: the
      // "text-coverage high" flag is 88% false positive (8 of 9 flagged clips
      // were clean), and apnews scored 0.005 with NO flags while capturing a
      // video rail instead of the article. A clean→flaw verdict change is a
      // human (or reviewed) judgment about the clip; a composite delta is not.
      try {
        prevFindings = JSON.parse(
          readFileSync(resolve(dir, 'visual-findings.json'), 'utf8'),
        ).findings ?? {};
      } catch { /* baseline predates verdict tracking */ }

      // Hash each side's CLIP image. A byte-identical clip is decisive: the
      // capture did not change, so a verdict that moved clean→flaw is a review
      // -standard difference, never a capture regression. Without this the
      // `bothStamped` test alone mislabels them — measured 2026-09-13: of 28
      // clean→flaw pairs with both sides stamped, FIFTEEN had byte-identical
      // clips (bbc-news, wikipedia-en, github-repo, python-docs, …), all of
      // them shown to the user as "REGRESSED clean→flaw". A stamp means someone
      // reviewed it, not that they applied the same standard; the pixels are
      // the only evidence that settles it.
      for (const site of Object.keys(prev)) {
        const a = clipHash(resolve(dir, `${site}--2-clip.png`));
        const b = clipHash(resolve(RUN_DIR, `${site}--2-clip.png`));
        if (a && b && a === b) prevSameImage.add(site);
      }
    }
  } catch { /* no backups — regression sort degrades to "no data" */ }

  /**
   * Classify a domain's change since the previous run.
   * Rank 0 sorts to the top of the regression view.
   *   0 worse     — captured BOTH times, clip image changed
   *   1 new       — no previous record
   *   2 same      — unchanged, or moved less than the noise floor
   *   3 better    — verdict improved since the baseline
   *   4 unrun     — skipped this run, or last run, or both
   *
   * A SKIP IS NOT A REGRESSION. A skip means the page never loaded — a bot
   * wall, a 403, a rate-limited IP, a dead URL — so it says nothing about the
   * capture pipeline, which is what this view exists to police. Treating skips
   * as regressions actively misleads: after the 2026-09-08 session (where the
   * exit IP was burnt and even Google served a captcha) SEVEN domains showed as
   * "BROKE" purely because a wall appeared that evening, burying the five real
   * capture regressions underneath them.
   *
   * Skips still get a pill (see regPill) so a domain that stopped loading is
   * visible — it just sorts BELOW every real capture change instead of above.
   */
  function regressionOf(site, rec, finding) {
    const p = prev[site];
    const isOk = rec.status === 'ok';
    const wasOk = p?.status === 'ok';
    // Either side missing a real capture ⇒ no pipeline comparison is possible.
    if (!isOk || (p && !wasOk)) {
      return { kind: !isOk && p && !wasOk ? 'stillskip' : (!isOk ? 'nowskip' : 'wasskip'), rank: 6, delta: 0 };
    }
    if (!p) return { kind: 'new', rank: 4, delta: 0 };

    // HIGHEST PRIORITY: an explicit `regression` field on the verdict. A
    // reviewer who compared this capture against the previous run's image and
    // said so outranks every inference — the image-changed test and the verdict
    // diff are both proxies for exactly this question.
    if (finding?.regression === 'regressed') {
      return { kind: 'stated-regression', rank: -1, delta: 0 };
    }
    // …and the SAME authority in the other direction. A reviewer who opened both
    // images and recorded `regression: "none"` has answered exactly the question
    // the verdict-diff below only guesses at, so an explicit "no" must outrank it
    // too. Honouring only "regressed" was asymmetric: lastfm, imdb-name and
    // newsweek were each confirmed against the baseline image (lastfm's
    // brown/olive unreadable text is plainly IN the baseline that was filed
    // `clean`), marked `none`, and still rendered as "REGRESSED clean→flaw".
    // Not an early return: it must not mask a real COMPOSITE jump, only the
    // verdict-diff inference below, which is the part it actually answers.
    const reviewerSaysNo = finding?.regression === 'none';

    // NEXT: the visual verdict — a judgment about the CLIP, which is what a
    // capture regression actually means.
    //
    // Verdict changes are used whenever BOTH sides have one — the baseline's 206
    // verdicts carry specific, image-derived notes and are real review, not
    // filler. But their CONFIDENCE varies, and visual-findings.json says so
    // itself: "AI review has produced confident, specific notes that did not
    // match the image (walmart's empty section headings and ytmusic-album's
    // missing title were both filed as 'clean'). An existing verdict is NOT
    // evidence a person looked."
    //
    // So a verdict change against an UNSTAMPED baseline entry is reported as
    // `verdict-recheck` (rank 1: worth opening, may be a review-standard
    // difference rather than a capture change) while a change where both sides
    // carry a `reviewedAt` stamp is a real `verdict-worse` (rank 0). Collapsing
    // the two is wrong in both directions: gating them out entirely discards 206
    // usable verdicts, and treating them as equal reported 31 clean→flaw flips
    // that were only this session's stricter re-review.
    const pf = prevFindings[site], nf = finding;
    const pv = pf?.verdict, nv = nf?.verdict;
    const sev = { clean: 0, flaw: 1, critical: 2 };
    const comparable = pv in sev && nv in sev;
    const bothStamped = !!pf?.reviewedAt && !!nf?.reviewedAt;
    if (comparable && sev[nv] > sev[pv] && !reviewerSaysNo) {
      // A BYTE-IDENTICAL clip settles it: the capture is unchanged, so the
      // verdict moved because the standard did, not because anything broke.
      // This outranks `bothStamped` — a stamp says someone reviewed it, not
      // that they applied the same standard, and both passes here were AI
      // review of differing strictness.
      if (prevSameImage.has(site)) {
        return { kind: 'verdict-standard', rank: 5, delta: 0, from: pv, to: nv };
      }
      // SCOPE: a regression needs a WORSE CAPTURE than last time, judged on the
      // same surface. When the new verdict is driven by a surface the baseline
      // never reviewed — typically `where: "cast"` against a clip-only baseline
      // — there is no prior judgment of that surface to have regressed FROM.
      // It is a first-time finding, so it must not be reported as a regression.
      // Measured 2026-09-13: 7 of the 26 remaining REGRESSED cards read
      // "Clip is clean; on the cast …" (aws-blog, chosun, github-pr, huffpost,
      // kotaku, mdn, smashingmagazine, techcrunch, theatlantic) — the clip was
      // still clean and only the newly-reviewed cast carried the flaw.
      const scope = (w) => (w === 'both' || w === 'clip+cast' ? 'both' : w || 'clip');
      if (scope(nf.where) !== 'both' && scope(pf.where) !== scope(nf.where)) {
        return { kind: 'verdict-newscope', rank: 5, delta: 0, from: pv, to: nv, surface: scope(nf.where) };
      }
      // CO-REVIEWED: both verdicts written on the same DAY are one review
      // session that happened to cover both folders — never a run-over-run
      // comparison, so a difference between them is the reviewer's standard
      // moving mid-session, not the capture changing. Measured 2026-09-13: all
      // three REGRESSED cards a human spot-checked (lastfm, imdb-name,
      // newsweek) were stamped 2026-09-09 on BOTH sides, and lastfm's
      // "brown/olive background, unreadable dark text" was plainly present in
      // the baseline image that had been filed `clean`.
      if (pf.reviewedAt.slice(0, 10) === nf.reviewedAt.slice(0, 10)) {
        return { kind: 'verdict-coreviewed', rank: 5, delta: 0, from: pv, to: nv };
      }
      // A verdict diff is NOT a regression, however well-stamped both sides are.
      // A REGRESSION IS A VISUAL JUDGMENT: it means someone opened the baseline
      // image and confirmed the defect is absent there. Only the reviewer can
      // say that, via `regression: "regressed"` (the stated-regression branch
      // above). Everything here is an inference from two verdicts written to
      // possibly-different standards, so it surfaces as "recheck" — worth
      // opening, claiming nothing.
      //
      // Measured 2026-09-15: `verdict-worse` (rank 0, labelled REGRESSED)
      // produced FOURTEEN false positives in one sweep — chicagotribune,
      // mathoverflow, zdnet, mayoclinic, thenation, tiktok-foryou, pcmag,
      // asahi, economist, aljazeera-ar, motherjones, rottentomatoes,
      // goodreads-author, steam — every one a stricter re-review rather than a
      // worse capture. mayoclinic settled it: the oversized logo flagged as the
      // new flaw is PLAINLY PRESENT in the baseline image filed `clean`.
      //
      // Byte-similarity cannot rescue this. The md5 guard above catches only
      // exactly-identical clips, and these deltas ran 0.11%..12.93% (mayoclinic
      // 545 bytes of 475,069) — live-page noise and real article churn overlap,
      // so no size threshold separates them.
      return { kind: 'verdict-recheck', rank: 1, delta: 0, from: pv, to: nv, stamped: bothStamped };
    }
    if (comparable && sev[nv] < sev[pv]) {
      return { kind: 'verdict-better', rank: 5, delta: 0, from: pv, to: nv };
    }

    // SECONDARY: did the capture CHANGE? The composite delta used to live here,
    // but it was measured at chance (of 5 domains whose composite worsened, 2
    // were bad — the 37% base rate), so it ranked noise above real work. A clip
    // whose bytes differ is an objective "there is something new to look at",
    // with no claim about whether it got better or worse.
    if (prevSameImage.has(site)) return { kind: 'same', rank: 3, delta: 0 };
    return { kind: 'changed', rank: 2, delta: 0 };
  }

  // Build a plain data array the client sorts; default worst-score-first.
  const data = [...sites.entries()].map(([site, e]) => {
    const rec = e.rec ?? {};
    const scored = rec.status === 'ok' && rec.scores;
    const finding = findings[site] ?? null;
    // Numeric rank for "sort by finding": reviewed verdicts first (0..2), then
    // un-reviewed domains (3) last.
    const findingRank = finding ? VERDICT_RANK[finding.verdict] ?? 3 : 3;
    // An 'ok' record WITHOUT a scores object is a manual headed capture
    // (tools/sweep-headed-manual.mjs writes source+clip images but doesn't run
    // the heuristics). Mark it so the badge reads "unscored", not a bogus -1.
    const unscored = rec.status === 'ok' && !rec.scores;
    const reg = regressionOf(site, rec, finding);
    return {
      site,
      reg: reg.kind,
      regRank: reg.rank,
      regFrom: reg.from ?? '',
      regTo: reg.to ?? '',
      regSurface: reg.surface ?? '',
      prevSeverity: prevFindings[site]?.severity ?? null,
      prevStatus: prev[site]?.status ?? null,
      mtime: e.mtime,
      status: rec.status ?? 'unknown',
      unscored,
      note: rec.note ?? '',
      skipReason: rec.skipReason ?? '',
      // Reviewed severity 0-10; null when unreviewed. Sorts unreviewed last so
      // the "severity" view leads with judged defects, not with unknowns.
      severity: typeof finding?.severity === 'number' ? finding.severity : null,
      sevSort: typeof finding?.severity === 'number' ? finding.severity : -1,
      scores: scored ? rec.scores : null,
      finding,
      findingRank,
      url: rec.url ?? '',
      source: e.source.sort(),
      clip: e.clip.sort(),
      cast: e.cast.sort(),
    };
  });

  const scoredCount = data.filter(d => d.status === 'ok' && !d.unscored).length;
  const unscoredCount = data.filter(d => d.unscored).length;
  const skipCount = data.filter(d => d.status === 'skip').length;
  const countLabel = `${scoredCount} scored${unscoredCount ? ` · ${unscoredCount} captured (unscored)` : ''} · ${skipCount} skipped`;

  // Overview column: a fixed-height scroll panel (the row preview).
  const col = (label, list) => {
    const imgs = list.map((f) => `<img src="${src(f)}" alt="${f}" loading="lazy">`).join('\n');
    return `<div class="col"><div class="col-label">${label}${list.length ? '' : ' <em>(none)</em>'}</div><div class="scroll">${imgs}</div></div>`;
  };
  // Detail column: independent scroll panel (.dscroll) + a header with a hide (×)
  // button so you can drop one column and compare the other two side by side.
  const detailCol = (kind, label, list) => {
    const imgs = list.map((f) => `<img src="${src(f)}" alt="${f}" loading="lazy">`).join('\n');
    return `<div class="col col-${kind}"><div class="col-label">${label}${list.length ? '' : ' <em>(none)</em>'} <button class="hide-col" title="hide this column">×</button></div><div class="dscroll">${imgs}</div></div>`;
  };

  // The badge now carries the REVIEWED severity (0-10, written by
  // record-verdict.mjs), not a computed score. The old composite badge was
  // measured anti-predictive, so a number in this slot actively misled — a
  // 0.005 badge sat on apnews while it captured the wrong block entirely.
  const badge = (d) => {
    if (d.status === 'skip') return `<span class="badge skip">SKIP</span>`;
    if (d.unscored) return `<span class="badge unk" title="manual headed capture — not scored">captured</span>`;
    if (d.status !== 'ok') return `<span class="badge unk">?</span>`;
    const sev = d.severity;
    if (sev === null) return `<span class="badge unk" title="captured, not yet reviewed">unrated</span>`;
    const cls = sev >= 7 ? 'bad' : sev >= 3 ? 'warn' : 'ok';
    return `<span class="badge ${cls}" title="reviewed severity (0 = perfect, 10 = unusable)">${sev}/10</span>`;
  };

  const scoreDetail = (d) => {
    if (d.status === 'skip') return `<span class="reason">${escapeHtml(d.skipReason)}</span>`;
    if (d.unscored) return `<span class="reason">${escapeHtml(d.note || 'manual headed capture — not scored')}</span>`;
    if (!d.scores) return '';
    const s = d.scores;
    // Diagnostics only — context for someone already looking at the image. No
    // flags: they carried no signal (domains with zero flags were bad at exactly
    // the 37% base rate). See sweepScorers.ts's header.
    return `<span class="metrics" title="recorded diagnostics — not a quality score">cov ${(s.textCoverage * 100).toFixed(0)}% · blank ${(s.blankRatio * 100).toFixed(0)}% · distort ${s.aspectDistorted} · chrome ${s.chromeHits}</span>`;
  };

  // Human visual verdict pill (critical / flaw / clean) + its note. Distinct from
  // the numeric heuristic badge — this is the reviewed ground truth.
  const verdictPill = (d) => {
    if (!d.finding) return '';
    const v = d.finding.verdict;
    const where = d.finding.where ? ` <span class="vwhere">${escapeHtml(d.finding.where)}</span>` : '';
    return `<span class="verdict v-${v}" title="visual review">${v}${where}</span>`;
  };
  const verdictNote = (d) => d.finding?.note
    ? `<div class="vnote v-${d.finding.verdict}">${escapeHtml(d.finding.note)}</div>` : '';
  // A REGRESSION's delta gets its OWN line, visually distinct from the general
  // note — the two answer different questions ("what changed" vs "what's wrong
  // now") and burying the first inside the second is what made target's first
  // regression verdict unreadable at a glance.
  // The link into the BASELINE gallery's own card for this site is what makes a
  // regression checkable instead of merely asserted: the reviewer lands on the
  // before-image rather than reconstructing which backup folder to open and
  // hunting the domain in it. Points at the backup's sweep-gallery.html#site-X
  // (build it with: node sweep-gallery.mjs --run-dir <backup-folder>), and is
  // a sibling directory away, so a relative href works from either gallery.
  const baselineLink = (site) => prevLabel
    ? ` <a class="baseline-link" href="../${escapeHtml(prevLabel)}/sweep-gallery.html#site-${escapeHtml(site)}" target="_blank" rel="noopener" title="Open this site's card in the baseline gallery (${escapeHtml(prevLabel.replace('corpus-sweep-run--backup-', ''))})">before ↗</a>`
    : '';
  const regressionLine = (d) => d.finding?.regression === 'regressed' && d.finding?.regressedFrom
    ? `<div class="vregression">⚠ REGRESSED — ${escapeHtml(d.finding.regressedFrom)}${baselineLink(d.site)}</div>` : '';

  // Change-since-last-run pill. Only rendered when it carries information:
  // "same" and "still skipped" are the boring majority and would just be noise
  // on every row. Shows the previous status for broke/fixed so the row explains
  // itself without a diff.
  const regPill = (d) => {
    if (!d.reg || d.reg === 'same' || d.reg === 'stillskip') return '';
    const label = {
      // Verdict changes lead: these are judgments about the CLIP.
      // The ONLY label that claims a regression, and it is never inferred: it
      // requires `regression: "regressed"` written by a reviewer who opened the
      // baseline image. `verdict-worse` used to sit here, inferred from a
      // verdict diff; it produced 14 false positives in one sweep and has been
      // removed rather than retuned (see the verdict-recheck branch above).
      'stated-regression': `REGRESSION (reviewer-confirmed)`,
      // NOT phrased as a change to the capture. Measured: 30 of 35 of these had
      // an unchanged clip — only the verdict moved, because the baseline entry
      // was never checked against the image. "recheck clean→flaw" read like a
      // regression claim; this says what it actually is.
      'verdict-recheck': `verdict differs (was ${d.regFrom}, unverified)`,
      // Same pixels, different verdict — say so plainly rather than implying a
      // capture change. Ranked with the "better" tier so it sorts well below
      // every real capture change.
      'verdict-standard': `same image, stricter review (was ${d.regFrom})`,
      // First look at this surface — no prior judgment of it to regress from.
      'verdict-newscope': `${d.regSurface || 'cast'} reviewed first time (clip was ${d.regFrom})`,
      // Both verdicts from one review session — a standard difference, not a run diff.
      'verdict-coreviewed': `re-reviewed same session (was ${d.regFrom})`,
      'verdict-better': `improved ${d.regFrom}→${d.regTo}`,
      // No direction claimed: the bytes differ, which says there is something
      // new to look at, not that it got worse. Judging that is the review's job.
      changed: `capture changed`,
      // Deliberately NOT called a regression: the page never loaded, so there is
      // no capture to have regressed. Worded as a run outcome, not a verdict.
      nowskip: `didn't load (was ok)`,
      wasskip: `loaded (was skip)`,
      new: `new`,
    }[d.reg] ?? d.reg;
    // Every card that CLAIMS a change gets a link into the baseline gallery's
    // own card for the same site, so the claim is checkable in one click
    // instead of hunting the right backup folder by hand. Previously only a
    // reviewer-stated regression carried one, which left the gallery-COMPUTED
    // verdict-worse cards — the ones a reviewer most needs to verify — with no
    // way back to the before-image.
    const wantsBefore = ['stated-regression', 'verdict-worse', 'verdict-recheck',
      'verdict-standard', 'verdict-newscope', 'verdict-coreviewed', 'verdict-better', 'changed'].includes(d.reg);
    return `<span class="reg reg-${d.reg}" title="vs previous run">${label}</span>`
      + (wantsBefore ? baselineLink(d.site) : '');
  };

  // Clickable overview rows. Scored domains link to their detail view; skip rows
  // are compact (no images to expand) so they render as a plain, non-link block.
  const rows = data.map((d) => {
    const head = `<h2>
        ${badge(d)}
        ${verdictPill(d)}
        ${regPill(d)}
        <span class="name">${d.site}</span>
        ${d.url ? `<a class="src-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
        <span class="ts">${d.mtime ? new Date(d.mtime).toLocaleString() : ''}</span>
        ${d.status === 'skip' ? '' : '<span class="open-hint">click to expand →</span>'}
      </h2>
      ${regressionLine(d)}
      ${verdictNote(d)}
      <div class="detail-line">${scoreDetail(d)}</div>`;
    const dataAttrs = `data-sev="${d.sevSort}" data-mtime="${d.mtime}" data-status="${d.status}" data-finding="${d.findingRank}" data-regrank="${d.regRank}" data-reg="${d.reg}"`;
    if (d.status === 'skip') {
      return `<div class="site skip-row" ${dataAttrs}>${head}</div>`;
    }
    // A plain <div> (not an <a>) with a JS click handler: an <a> wrapping the
    // tall scrollable preview panels doesn't reliably navigate when you click
    // inside a panel. data-target carries the detail hash; the click handler
    // below opens it (ignoring clicks on the source↗ link).
    return `
    <div class="site" data-target="#site-${d.site}" ${dataAttrs}>
      ${head}
      <div class="cols">
        ${col('source (live site)', d.source)}
        ${col('clip (/clips)', d.clip)}
        ${col('cast (/discerns)', d.cast)}
      </div>
    </div>`;
  }).join('\n');

  // Full-page detail sections, one per SCORED domain — hidden until #hash active.
  const details = data.filter(d => d.status !== 'skip').map((d) => `
    <section class="detail" id="site-${d.site}">
      <div class="detail-bar">
        <div class="detail-bar-row">
          <button class="back" type="button">← back</button>
          ${badge(d)}
          ${verdictPill(d)}
        ${regPill(d)}
          <h2>${d.site}</h2>
          ${d.url ? `<a class="src-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
          <span class="detail-flags">${scoreDetail(d)}</span>
          <span class="restore-wrap"><button class="restore-cols" hidden>show all columns</button></span>
        </div>
        ${regressionLine(d)}
        ${verdictNote(d)}
      </div>
      <div class="detail-cols">
        ${detailCol('source', 'source (live site)', d.source)}
        ${detailCol('clip', 'clip (/clips)', d.clip)}
        ${detailCol('cast', 'cast (/discerns)', d.cast)}
      </div>
      <div class="scroll-driver"></div>
    </section>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Corpus sweep — ${countLabel}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #888; margin: 0 0 12px; }
  a { color: inherit; text-decoration: none; }

  .toolbar { position: sticky; top: 0; background: Canvas; padding: 8px 0 12px; z-index: 3;
    border-bottom: 2px solid #8884; margin-bottom: 16px; display: flex; gap: 12px; align-items: center; }
  .toolbar button { font: inherit; padding: 5px 12px; border: 1px solid #8886; border-radius: 6px;
    background: none; cursor: pointer; }
  .toolbar button.active { background: #4a90d9; color: #fff; border-color: #4a90d9; }
  .toolbar .count { color: #888; font-size: 13px; margin-left: auto; }

  /* ---- overview (default) ---- */
  #overview .site { display: block; margin-bottom: 28px; border-top: 2px solid #8884; padding-top: 10px; }
  #overview .site[data-target] { cursor: pointer; }
  #overview .site[data-target]:hover h2 .open-hint { opacity: 1; }
  #overview .site[data-target]:hover .cols { outline: 2px solid #4a90d9aa; outline-offset: 4px; border-radius: 6px; }
  .site h2 { font-size: 15px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
  .site .name { text-transform: capitalize; font-weight: 600; }
  .src-link { font-size: 12px; color: #4a90d9; font-weight: normal; }
  .ts { font-weight: normal; font-size: 12px; color: #888; }
  .open-hint { font-weight: normal; font-size: 12px; color: #4a90d9; opacity: 0; margin-left: auto; }
  .detail-line { font-size: 12.5px; color: #999; margin: 0 0 8px; display: flex; gap: 12px; flex-wrap: wrap; }
  .metrics { color: #888; }
  .flags { color: #c66; }
  .flags.ok { color: #6a6; }
  .reason { color: #c96; }
  .skip-row { opacity: 0.75; }

  .badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 5px; min-width: 46px;
    text-align: center; }
  .badge.ok   { background: #2e7d3220; color: #4caf50; }
  .badge.warn { background: #f9a82520; color: #f9a825; }
  .badge.bad  { background: #c6282820; color: #e05555; }
  .badge.skip { background: #8883; color: #999; }
  .badge.unk  { background: #8883; color: #999; }

  /* Human visual-review verdict pill + note. */
  .verdict { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 2px 8px; border-radius: 20px; }
  .verdict .vwhere { font-weight: 400; text-transform: none; opacity: .7; letter-spacing: 0; }
  .verdict.v-critical { background: #c6282822; color: #e05555; }
  .verdict.v-flaw     { background: #f9a82522; color: #f9a825; }
  .verdict.v-clean    { background: #2e7d3222; color: #4caf50; }
  /* Deliberately BLUE, not gray/muted — "blocked" is not a weaker or
     uncertain version of the other verdicts, it's a different KIND of
     result: we never reached real page content (bot-wall/403/dead URL/
     rate-limit), so there is nothing about our clipping to judge here. */
  .verdict.v-blocked  { background: #4a90d922; color: #4a90d9; }
  /* Change-since-last-run pill. Deliberately OUTLINED rather than filled so it
     reads as metadata about the run, never competing with the verdict pill,
     which is the judgment about the clip itself. */
  .reg { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 1px 7px; border-radius: 20px; border: 1px solid currentColor; }
  .reg-stated-regression { color: #fff; background: #c62828; border-color: #c62828; }
  .reg-verdict-worse   { color: #e05555; border-width: 2px; }
  .reg-verdict-recheck { color: #f9a825; }
  .reg-verdict-better { color: #4caf50; }
  /* Same pixels, stricter review — muted grey: it is not a capture change. */
  .reg-verdict-standard { color: #9e9e9e; }
  .reg-verdict-newscope { color: #9e9e9e; }
  .reg-verdict-coreviewed { color: #9e9e9e; }
  /* Neutral blue: the capture differs from the baseline, with no claim about
     which way. Colouring it amber would assert a regression nobody judged. */
  .reg-changed { color: #4a90d9; }
  /* Load outcomes, not capture verdicts — muted so they never read as a
     regression. A skip means the page was never reached. */
  .reg-nowskip { color: #4a90d9; }
  .reg-wasskip { color: #4a90d9; }
  .reg-new     { color: #9aa0a6; }
  .baseline { margin-left: auto; font-size: 11px; color: #9aa0a6; }
  .vnote { font-size: 12.5px; margin: 0 0 6px; padding-left: 2px; border-left: 3px solid transparent; padding-left: 8px; }
  .vnote.v-critical { color: #e05555; border-color: #e05555; }
  .vnote.v-flaw     { color: #cc9a3d; border-color: #f9a825; }
  .vnote.v-clean    { color: #7aa; border-color: #4caf5066; }
  .vnote.v-blocked  { color: #4a90d9; border-color: #4a90d966; }
  /* Deliberately styled as an ALERT, distinct from .vnote — it answers a
     different question ("what changed") than the note ("what's wrong now"),
     and the two must never be read as one run-on sentence. */
  .vregression { font-size: 12.5px; font-weight: 600; margin: 0 0 6px; padding: 4px 8px;
    color: #fff; background: #c62828; border-radius: 4px; }
  /* Link colour: the page has no dark background, so the standalone link in the
     h2 row must NOT be white — it was, because this rule was written only for
     the .vregression banner below (white text on red #c62828) and reused as-is
     when the link was added to the pill row, rendering it white-on-white and
     invisible. Default to the same blue as .src-link, and keep white ONLY
     inside the red banner. */
  .baseline-link { color: #4a90d9; text-decoration: underline; white-space: nowrap;
    font-size: 12px; font-weight: normal; margin-left: 6px; opacity: 0.92; }
  .vregression .baseline-link { color: #fff; }
  .baseline-link:hover { opacity: 1; }

  .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .col { min-width: 0; }
  .col-label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .col-label em { color: #c66; }
  .scroll { height: 55vh; overflow: auto; border: 1px solid #8883; border-radius: 6px; background: #7771; }
  .scroll img { display: block; width: 100%; height: auto; }
  .site.hidden { display: none; }

  /* ---- detail (shown when a #site-* hash is active) ---- */
  /* Detail visibility is driven by real history navigation (pushState), NOT the
     CSS :target hack — so browser Back restores the overview scroll position for
     free. JS toggles .active on the open detail + .detail-open on <body>. */
  .detail { display: none; }
  .detail.active { display: block; }
  body.detail-open #overview,
  body.detail-open .toolbar { display: none; }
  .detail-bar { position: sticky; top: 0; background: Canvas; padding: 8px 0 12px;
    border-bottom: 2px solid #8884; margin-bottom: 12px; z-index: 2; }
  .detail-bar-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .detail-bar h2 { font-size: 18px; margin: 0; text-transform: capitalize; }
  .detail-bar .detail-flags { font-size: 12.5px; color: #999; display: flex; gap: 12px; flex-wrap: wrap; }
  /* The verdict note under the sticky bar's top row — same visual language as
     the overview's .vnote, but capped so a long note can't push the bar (and
     therefore the sticky offset the columns below need) to an unpredictable
     height; full text is still in the title attribute. */
  .detail-bar .vnote { margin: 6px 0 0; max-width: 90ch; }
  .back { font: inherit; font-size: 14px; color: #4a90d9; border: 1px solid #4a90d966;
    border-radius: 6px; padding: 4px 10px; background: none; cursor: pointer; }
  .back:hover { background: #4a90d922; }
  .restore-wrap { margin-left: auto; }
  .restore-cols { font-size: 13px; color: #4a90d9; border: 1px solid #4a90d966; border-radius: 6px; padding: 4px 10px; background: none; cursor: pointer; }
  .restore-cols:hover { background: #4a90d922; }
  /* Columns re-flow to fill the width as some are hidden (grid auto-fits the
     visible ones). Sticky so they stay on screen while the .scroll-driver spacer
     below gives the page scrollbar its range (script maps page scroll → panels). */
  .detail-cols { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 16px;
    align-items: start; position: sticky; top: var(--bar-h, 62px); }
  .detail-cols .col { min-width: 0; }
  .detail-cols .col.hidden { display: none; }
  .detail-cols .col-label { font-size: 13px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
  .hide-col { margin-left: auto; font-size: 14px; line-height: 1; color: #888; background: none;
    border: 1px solid #8884; border-radius: 4px; width: 20px; height: 20px; cursor: pointer; }
  .hide-col:hover { color: #c66; border-color: #c66; }
  /* Each column is a viewport-tall scroll panel. Three ways to scroll:
     - the page scrollbar (right edge) or a wheel gesture over the columns scrolls
       ALL visible columns together (one motion, read straight down through them);
     - each panel's OWN scrollbar nudges just that one, to line it up with the others. */
  .detail-cols .dscroll { height: calc(100vh - var(--bar-h, 62px) - 28px); overflow: auto;
    border: 1px solid #8883; border-radius: 6px; background: #7771; overscroll-behavior: contain; }
  .detail-cols img { display: block; width: 100%; height: auto; }
  /* Invisible spacer that EXTENDS page height so the page scrollbar has a range;
     the script maps page scroll 1:1 onto every visible panel. Height (= the
     panels' hidden overflow) is set per-detail by the script. */
  .scroll-driver { width: 1px; pointer-events: none; }
</style></head>
<body>
  <div class="toolbar">
    <span>Sort:</span>
    <button id="sort-finding" class="active">visual finding</button>
    <button id="sort-regression" title="Ranks: verdict regressions where both runs were image-verified, then verdict differences against an unverified baseline entry (usually the OLD verdict was wrong, not a new defect), then captures whose clip image changed. Skips are not regressions and sort last.">regressions</button>
    <button id="sort-score" title="Reviewed severity 0-10 (10 = unusable). Unreviewed domains sort after the rated — no computed score stands in for a judgment — and skipped domains last of all, since a page that never loaded has nothing to rate.">worst severity</button>
    <button id="sort-date">newest run</button>
    <button id="filter-flagged">only flagged</button>
    <span class="count">${countLabel}</span>
    <span class="baseline">${prevLabel
      ? `regressions vs ${escapeHtml(prevLabel.replace('corpus-sweep-run--backup-', ''))}`
        + (prevIsMerged ? ' <b>(merged snapshot, not one full run)</b>' : '')
      : 'no baseline snapshot — regression sort unavailable'}</span>
  </div>
  <div id="overview">
    <h1>Corpus sweep — source · clip · cast</h1>
    <p class="hint">Click a scored domain to expand all three images full-page (page scroll / wheel moves them together; each panel's own scrollbar nudges just that one). Worst decile is at the top when sorted by score. <span style="font-weight:600; color:#4a90d9">Blocked</span> (blue) means we never reached real page content at all — bot-wall, 403, dead URL, rate-limit — and is not a verdict on our clipping. A paywalled page we captured faithfully up to the gate is <span style="font-weight:600; color:#4caf50">clean</span>, not blocked or flawed. Skips = page never loaded (infra, not a finding). Generated ${new Date().toLocaleString()}.</p>
    <div id="list">
      ${rows}
    </div>
  </div>
  ${details}
  <script>
    // ---- overview: sort + filter (the sweep's extras over live-gallery) ----
    const list = document.getElementById('list');
    const sites = () => [...list.querySelectorAll('.site')];
    const byFinding = document.getElementById('sort-finding');
    const byRegression = document.getElementById('sort-regression');
    const byScore = document.getElementById('sort-score');
    const byDate = document.getElementById('sort-date');
    const flaggedBtn = document.getElementById('filter-flagged');
    const sortBtns = [byFinding, byRegression, byScore, byDate];
    let flaggedOnly = false;

    function resort(key) {
      const els = sites();
      els.sort((a, b) => {
        if (key === 'finding') {
          // Reviewed verdict (critical→flaw→clean→unreviewed), then the reviewed
          // 0-10 severity within the same verdict as a tie-breaker.
          const fr = Number(a.dataset.finding) - Number(b.dataset.finding);
          if (fr !== 0) return fr;
          return Number(b.dataset.sev) - Number(a.dataset.sev);
        }
        if (key === 'regression') {
          // broke → changed → new → same → better → fixed → still-skipped.
          // Ties break on reviewed severity: within one rank, the worst-judged
          // clip is the one worth opening first.
          const rr = Number(a.dataset.regrank) - Number(b.dataset.regrank);
          if (rr !== 0) return rr;
          return Number(b.dataset.sev) - Number(a.dataset.sev);
        }
        if (key === 'score') {
          // A SKIP has no capture, so it has no severity to rank — it says
          // nothing about the pipeline (see the "a skip is not a regression"
          // note above). Sink every skip below the rated AND the unrated, so
          // the tail of this view is "couldn't load" rather than a mix of
          // "couldn't load" and "not yet judged", which read alike at a glance.
          const as = a.dataset.status === 'skip', bs = b.dataset.status === 'skip';
          if (as !== bs) return as ? 1 : -1;
          return Number(b.dataset.sev) - Number(a.dataset.sev);
        }
        return Number(b.dataset.mtime) - Number(a.dataset.mtime);
      });
      els.forEach((el) => list.appendChild(el));
    }
    function applyFilter() {
      for (const el of sites()) {
        // "Only flagged": anything the review marked critical/flaw, anything
        // rated 3+/10, plus skips.
        const fr = Number(el.dataset.finding);
        const flagged = fr <= 1 || Number(el.dataset.sev) >= 3 || el.dataset.status === 'skip';
        el.classList.toggle('hidden', flaggedOnly && !flagged);
      }
    }
    const setSort = (btn, key) => {
      sortBtns.forEach(b => b.classList.toggle('active', b === btn));
      resort(key);
    };
    byFinding.addEventListener('click', () => setSort(byFinding, 'finding'));
    byRegression.addEventListener('click', () => setSort(byRegression, 'regression'));
    byScore.addEventListener('click', () => setSort(byScore, 'score'));
    byDate.addEventListener('click', () => setSort(byDate, 'date'));
    flaggedBtn.addEventListener('click', () => { flaggedOnly = !flaggedOnly; flaggedBtn.classList.toggle('active', flaggedOnly); applyFilter(); });
    resort('finding'); // default: worst visual finding first

    // ---- Real history navigation (pushState), not the CSS :target hack ----
    // Each row-open pushes a history entry; browser Back pops it and natively
    // restores the overview scroll position. popstate syncs the DOM to whichever
    // state we're on, so Back/Forward and the ← back button all go through one path.
    const details = new Map([...document.querySelectorAll('.detail')].map(d => [d.id, d]));
    function render(siteId) {
      // siteId = 'site-x' to show that detail, or null/'' for the overview.
      let shown = null;
      details.forEach((el, id) => { const on = id === siteId; el.classList.toggle('active', on); if (on) shown = el; });
      document.body.classList.toggle('detail-open', !!shown);
      if (shown) { window.scrollTo(0, 0); shown.__sizeDriver?.(); }
    }
    function openDetail(siteId) {
      history.pushState({ siteId }, '', '#' + siteId);
      render(siteId);
    }
    window.addEventListener('popstate', (e) => render(e.state?.siteId ?? null));

    // Click a row anywhere → open its detail (except when clicking the source↗ link).
    list.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;              // let the source↗ link work
      const row = e.target.closest('.site[data-target]');
      if (!row) return;
      openDetail(row.dataset.target.slice(1)); // strip leading '#'
    });

    // ← back button → history.back() so the browser restores the overview scroll.
    document.querySelectorAll('.back').forEach(btn =>
      btn.addEventListener('click', () => history.back()));

    // Deep-link support: if the page loads already at #site-x, show that detail.
    if (location.hash.startsWith('#site-')) {
      history.replaceState({ siteId: location.hash.slice(1) }, '', location.hash);
      render(location.hash.slice(1));
    } else {
      history.replaceState({ siteId: null }, '', location.pathname + location.search);
    }

    // ---- detail: hide/restore columns + scroll all visible columns together ----
    // (Identical model to tools/live-gallery.mjs so the scroll behavior matches.)
    document.querySelectorAll('.detail').forEach((detail) => {
      const group = detail.querySelector('.detail-cols');
      const cols = [...group.querySelectorAll('.col')];
      const restoreBtn = detail.querySelector('.restore-cols');
      const driver = detail.querySelector('.scroll-driver');
      const bar = detail.querySelector('.detail-bar');
      const visiblePanels = () => cols.filter((c) => !c.classList.contains('hidden'))
        .map((c) => c.querySelector('.dscroll'));

      // The verdict pill/note make the sticky bar's height vary per-site (a
      // long note wraps to more lines) and with viewport width (the flex row
      // wraps sooner on a narrow window) — so --bar-h is measured, not a
      // constant. Both .detail-cols' sticky top offset and .dscroll's height
      // read this var, which is why sizeBar() must run BEFORE sizeDriver()
      // (dscroll's clientHeight depends on it).
      function sizeBar() {
        detail.style.setProperty('--bar-h', bar.offsetHeight + 'px');
      }

      cols.forEach((col) => {
        col.querySelector('.hide-col').addEventListener('click', () => {
          if (cols.filter((c) => !c.classList.contains('hidden')).length <= 1) return;
          col.classList.add('hidden');
          restoreBtn.hidden = false;
          sizeDriver();
        });
      });
      restoreBtn.addEventListener('click', () => {
        cols.forEach((c) => c.classList.remove('hidden'));
        restoreBtn.hidden = true;
        sizeDriver();
      });

      // The page scrollbar drives the panels: size the spacer to exactly the
      // tallest visible panel's hidden overflow, so the page's own scroll range
      // equals the panels' → window.scrollY maps onto scrollTop.
      function sizeDriver() {
        sizeBar();
        const panels = visiblePanels();
        const maxOverflow = Math.max(0, ...panels.map((p) => p.scrollHeight - p.clientHeight));
        driver.style.height = maxOverflow + 'px';
      }
      // Expose sizeDriver to the nav controller so it can (re)size on show.
      detail.__sizeDriver = sizeDriver;
      // "Active" = this detail is the one currently shown (nav toggles .active).
      const active = () => detail.classList.contains('active');

      // ALIGNMENT PRESERVATION: each panel keeps a manual offset. Page scroll sets
      // panel.scrollTop = scrollY + offset, so a nudge you gave one column with its
      // OWN scrollbar is preserved as the page scrolls.
      const offsets = new WeakMap();
      let syncing = false;

      window.addEventListener('scroll', () => {
        if (!active()) return;
        syncing = true;
        for (const p of visiblePanels()) {
          const off = offsets.get(p) || 0;
          p.scrollTop = Math.max(0, window.scrollY + off);
        }
        requestAnimationFrame(() => { syncing = false; });
      }, { passive: true });

      for (const p of cols.map((c) => c.querySelector('.dscroll'))) {
        p.addEventListener('scroll', () => {
          if (syncing || !active()) return;
          offsets.set(p, p.scrollTop - window.scrollY);
        }, { passive: true });
      }

      // Wheel over the columns scrolls the PAGE (which drives the panels).
      group.addEventListener('wheel', (e) => {
        if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        window.scrollBy(0, e.deltaY);
      }, { passive: false });

      // Re-size the driver when this detail is shown (nav calls __sizeDriver),
      // on window resize, and once images finish loading (scrollHeight grows).
      window.addEventListener('resize', () => { if (active()) sizeDriver(); });
      window.addEventListener('load', () => { if (active()) sizeDriver(); });
    });
  </script>
</body></html>`;

  writeFileSync(OUT, html, 'utf8');
  return OUT;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const out = build();
if (out) {
  // eslint-disable-next-line no-console
  console.log(`[sweep-gallery] wrote ${out}`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', out]]
      : process.platform === 'darwin' ? ['open', [out]]
      : ['xdg-open', [out]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  }
} else {
  // eslint-disable-next-line no-console
  console.log('[sweep-gallery] no corpus-sweep-run captures found — nothing to build');
}

export { build };
