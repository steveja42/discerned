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
// On top of that shared model the sweep keeps its own extras: a composite score
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = resolve(__dirname, '..', '..', '..', 'test-output', 'corpus-sweep-run');
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
  // `blocked` ranks last: there is no capture to review (hard 403 / bot wall), so
  // it is neither a defect in our pipeline nor a verified-clean clip. Keeping it
  // after `clean` stops permanently-walled domains from squatting the top of the
  // "sort by finding" view, where the actionable flaws belong.
  const VERDICT_RANK = { critical: 0, flaw: 1, clean: 2, blocked: 3 };
  let findings = {};
  try {
    findings = JSON.parse(readFileSync(resolve(RUN_DIR, 'visual-findings.json'), 'utf8')).findings ?? {};
  } catch { /* no findings file yet */ }

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
    return {
      site,
      mtime: e.mtime,
      status: rec.status ?? 'unknown',
      unscored,
      note: rec.note ?? '',
      skipReason: rec.skipReason ?? '',
      composite: scored ? rec.scores.composite : -1, // skips + unscored sort last
      flags: scored ? rec.scores.flags : [],
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

  const badge = (d) => {
    if (d.status === 'skip') return `<span class="badge skip">SKIP</span>`;
    if (d.unscored) return `<span class="badge unk" title="manual headed capture — not scored">captured</span>`;
    if (d.status !== 'ok') return `<span class="badge unk">?</span>`;
    const c = d.composite;
    const cls = c >= 0.5 ? 'bad' : c >= 0.25 ? 'warn' : 'ok';
    return `<span class="badge ${cls}">${c.toFixed(3)}</span>`;
  };

  const scoreDetail = (d) => {
    if (d.status === 'skip') return `<span class="reason">${escapeHtml(d.skipReason)}</span>`;
    if (d.unscored) return `<span class="reason">${escapeHtml(d.note || 'manual headed capture — not scored')}</span>`;
    if (!d.scores) return '';
    const s = d.scores;
    const flags = d.flags.length ? `<span class="flags">${d.flags.map(escapeHtml).join(' · ')}</span>` : '<span class="flags ok">clean</span>';
    return `<span class="metrics">cov ${(s.textCoverage * 100).toFixed(0)}% · blank ${(s.blankRatio * 100).toFixed(0)}% · distort ${s.aspectDistorted} · chrome ${s.chromeHits}</span> ${flags}`;
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

  // Clickable overview rows. Scored domains link to their detail view; skip rows
  // are compact (no images to expand) so they render as a plain, non-link block.
  const rows = data.map((d) => {
    const head = `<h2>
        ${badge(d)}
        ${verdictPill(d)}
        <span class="name">${d.site}</span>
        ${d.url ? `<a class="src-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
        <span class="ts">${d.mtime ? new Date(d.mtime).toLocaleString() : ''}</span>
        ${d.status === 'skip' ? '' : '<span class="open-hint">click to expand →</span>'}
      </h2>
      ${verdictNote(d)}
      <div class="detail-line">${scoreDetail(d)}</div>`;
    const dataAttrs = `data-composite="${d.composite}" data-mtime="${d.mtime}" data-status="${d.status}" data-finding="${d.findingRank}"`;
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
        <button class="back" type="button">← back</button>
        ${badge(d)}
        <h2>${d.site}</h2>
        ${d.url ? `<a class="src-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
        <span class="detail-flags">${scoreDetail(d)}</span>
        <span class="restore-wrap"><button class="restore-cols" hidden>show all columns</button></span>
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
  .verdict.v-blocked  { background: #60606022; color: #9aa0a6; }
  .vnote { font-size: 12.5px; margin: 0 0 6px; padding-left: 2px; border-left: 3px solid transparent; padding-left: 8px; }
  .vnote.v-critical { color: #e05555; border-color: #e05555; }
  .vnote.v-flaw     { color: #cc9a3d; border-color: #f9a825; }
  .vnote.v-clean    { color: #7aa; border-color: #4caf5066; }
  .vnote.v-blocked  { color: #9aa0a6; border-color: #9aa0a655; }

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
    display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #8884; margin-bottom: 12px; z-index: 2; flex-wrap: wrap; }
  .detail-bar h2 { font-size: 18px; margin: 0; text-transform: capitalize; }
  .detail-bar .detail-flags { font-size: 12.5px; color: #999; display: flex; gap: 12px; flex-wrap: wrap; }
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
    align-items: start; position: sticky; top: 62px; }
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
  .detail-cols .dscroll { height: calc(100vh - 90px); overflow: auto;
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
    <button id="sort-score">worst score</button>
    <button id="sort-date">newest run</button>
    <button id="filter-flagged">only flagged</button>
    <span class="count">${countLabel}</span>
  </div>
  <div id="overview">
    <h1>Corpus sweep — source · clip · cast</h1>
    <p class="hint">Click a scored domain to expand all three images full-page (page scroll / wheel moves them together; each panel's own scrollbar nudges just that one). Worst decile is at the top when sorted by score. Skips = page never loaded (infra, not a finding). Generated ${new Date().toLocaleString()}.</p>
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
    const byScore = document.getElementById('sort-score');
    const byDate = document.getElementById('sort-date');
    const flaggedBtn = document.getElementById('filter-flagged');
    const sortBtns = [byFinding, byScore, byDate];
    let flaggedOnly = false;

    function resort(key) {
      const els = sites();
      els.sort((a, b) => {
        if (key === 'finding') {
          // Reviewed verdict severity (critical→flaw→clean→unreviewed), then
          // worst composite within the same verdict as a tie-breaker.
          const fr = Number(a.dataset.finding) - Number(b.dataset.finding);
          if (fr !== 0) return fr;
          return Number(b.dataset.composite) - Number(a.dataset.composite);
        }
        if (key === 'score') return Number(b.dataset.composite) - Number(a.dataset.composite);
        return Number(b.dataset.mtime) - Number(a.dataset.mtime);
      });
      els.forEach((el) => list.appendChild(el));
    }
    function applyFilter() {
      for (const el of sites()) {
        // "Only flagged" now respects the human verdict too: show anything the
        // review marked critical/flaw, plus high-composite + skips.
        const fr = Number(el.dataset.finding);
        const flagged = fr <= 1 || Number(el.dataset.composite) >= 0.25 || el.dataset.status === 'skip';
        el.classList.toggle('hidden', flaggedOnly && !flagged);
      }
    }
    const setSort = (btn, key) => {
      sortBtns.forEach(b => b.classList.toggle('active', b === btn));
      resort(key);
    };
    byFinding.addEventListener('click', () => setSort(byFinding, 'finding'));
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
      const visiblePanels = () => cols.filter((c) => !c.classList.contains('hidden'))
        .map((c) => c.querySelector('.dscroll'));

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
