#!/usr/bin/env node
// Builds test-output/live-visual-run/gallery.html — a single page that shows every
// live visual capture as a row of three side-by-side scrollable panels
// (source | clip | cast), so the tall 609×8000 strips can be reviewed together
// without opening each PNG individually.
//
// Scans live-visual-run/ for {site}--1-source.png / --2-clip.png / --3-cast.png
// (plus any {site}--2-clip-<variant>.png) and groups them by site.
//
// Run standalone:  node tests/e2e/tools/live-gallery.mjs [--open]
// The live *-visual specs also invoke it (fire-and-forget) in their finally block.

import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = resolve(__dirname, '..', '..', '..', 'test-output', 'live-visual-run');
const OUT = resolve(RUN_DIR, 'gallery.html');

// name pattern: <site>--<order>-<type>[-<variant>].png
const RE = /^(.+?)--(\d+)-(source|clip|cast)(?:-([a-z]+))?\.png$/;

function build() {
  let files;
  try {
    files = readdirSync(RUN_DIR).filter((f) => f.endsWith('.png'));
  } catch {
    return null; // dir doesn't exist yet
  }

  /** @type {Map<string, {source: string[], clip: string[], cast: string[], mtime: number}>} */
  const sites = new Map();
  for (const f of files) {
    const m = RE.exec(f);
    if (!m) continue;
    const [, site, , type, variant] = m;
    // Skip variant crops (goodreads --2-clip-hero/-mid/-author, breitbart
    // --2-clip-top/-full etc.) — they're zoom-ins of the same clip and just clutter
    // the column. The gallery shows only the plain {site}--N-{type}.png; the crop
    // files still exist on disk.
    if (variant) continue;
    if (!sites.has(site)) sites.set(site, { source: [], clip: [], cast: [], mtime: 0 });
    const entry = sites.get(site);
    entry[type].push(f);
    try { entry.mtime = Math.max(entry.mtime, statSync(resolve(RUN_DIR, f)).mtimeMs); } catch { /* ignore */ }
  }
  if (sites.size === 0) return null;

  // Newest-run sites first.
  const ordered = [...sites.entries()].sort((a, b) => b[1].mtime - a[1].mtime);

  // Overview column: a fixed-height scroll panel (the row preview).
  const col = (label, list) => {
    const imgs = list.sort().map((f) => `<img src="./${f}" alt="${f}" loading="lazy">`).join('\n');
    return `<div class="col"><div class="col-label">${label}${list.length ? '' : ' <em>(none)</em>'}</div><div class="scroll">${imgs}</div></div>`;
  };
  // Detail column: independent scroll panel (.dscroll) + a header with a hide (×)
  // button so you can drop one column and compare the other two side by side.
  // `kind` is source|clip|cast (used as a class for the hide toggle).
  const detailCol = (kind, label, list) => {
    const imgs = list.sort().map((f) => `<img src="./${f}" alt="${f}" loading="lazy">`).join('\n');
    return `<div class="col col-${kind}"><div class="col-label">${label}${list.length ? '' : ' <em>(none)</em>'} <button class="hide-col" title="hide this column">×</button></div><div class="dscroll">${imgs}</div></div>`;
  };

  // Clickable overview rows (the whole row links to that site's detail view).
  const rows = ordered.map(([site, e]) => `
    <a class="site" href="#site-${site}">
      <h2>${site} <span class="ts">${new Date(e.mtime).toLocaleString()}</span> <span class="open-hint">click to expand →</span></h2>
      <div class="cols">
        ${col('source (live site)', e.source)}
        ${col('clip (/clips)', e.clip)}
        ${col('cast (/discerns)', e.cast)}
      </div>
    </a>`).join('\n');

  // Full-page detail sections, one per site — hidden until their #hash is active.
  const details = ordered.map(([site, e]) => `
    <section class="detail" id="site-${site}">
      <div class="detail-bar">
        <a class="back" href="#">← back</a>
        <h2>${site}</h2>
        <span class="ts">${new Date(e.mtime).toLocaleString()}</span>
        <span class="restore-wrap"><button class="restore-cols" hidden>show all columns</button></span>
      </div>
      <div class="detail-cols">
        ${detailCol('source', 'source (live site)', e.source)}
        ${detailCol('clip', 'clip (/clips)', e.clip)}
        ${detailCol('cast', 'cast (/discerns)', e.cast)}
      </div>
      <div class="scroll-driver"></div>
    </section>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Live visual captures</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #888; margin: 0 0 20px; }
  a { color: inherit; text-decoration: none; }

  /* ---- overview (default) ---- */
  #overview .site { display: block; margin-bottom: 32px; border-top: 2px solid #8884;
    padding-top: 12px; cursor: pointer; }
  #overview .site:hover h2 .open-hint { opacity: 1; }
  #overview .site:hover .cols { outline: 2px solid #4a90d9aa; outline-offset: 4px; border-radius: 6px; }
  .site h2 { font-size: 16px; margin: 0 0 8px; text-transform: capitalize; }
  .ts { font-weight: normal; font-size: 12px; color: #888; }
  .open-hint { font-weight: normal; font-size: 12px; color: #4a90d9; opacity: 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .col { min-width: 0; }
  .col-label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .col-label em { color: #c66; }
  .scroll { height: 60vh; overflow: auto; border: 1px solid #8883; border-radius: 6px; background: #7771; }
  .scroll img { display: block; width: 100%; height: auto; }

  /* ---- detail (shown when a #site-* hash is active) ---- */
  .detail { display: none; }
  .detail:target { display: block; }
  /* When any detail is targeted, hide the overview so the site fills the page. */
  body:has(.detail:target) #overview { display: none; }
  .detail-bar { position: sticky; top: 0; background: Canvas; padding: 8px 0 12px;
    display: flex; align-items: baseline; gap: 12px; border-bottom: 2px solid #8884; margin-bottom: 12px; z-index: 2; }
  .detail-bar h2 { font-size: 18px; margin: 0; text-transform: capitalize; }
  .back { font-size: 14px; color: #4a90d9; border: 1px solid #4a90d966; border-radius: 6px; padding: 4px 10px; }
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
  <div id="overview">
    <h1>Live visual captures — source · clip · cast</h1>
    <p class="hint">Click a site to expand all three images full-page. Newest run first. Generated ${new Date().toLocaleString()}.</p>
    ${rows}
  </div>
  ${details}
  <script>
    // Per-detail behavior: hide/restore columns, and scroll all VISIBLE columns
    // together via the page scrollbar or a wheel gesture (each panel's own
    // scrollbar still nudges just that one for alignment).
    document.querySelectorAll('.detail').forEach((detail) => {
      const group = detail.querySelector('.detail-cols');
      const cols = [...group.querySelectorAll('.col')];
      const restoreBtn = detail.querySelector('.restore-cols');
      const driver = detail.querySelector('.scroll-driver');
      const visiblePanels = () => cols.filter((c) => !c.classList.contains('hidden'))
        .map((c) => c.querySelector('.dscroll'));

      // Hide a column (keep at least one visible). Reveal the "show all" button.
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
      // Only act while THIS detail is the active target (its hash is current).
      const active = () => location.hash === '#' + detail.id;

      // ALIGNMENT PRESERVATION: each panel keeps a manual offset. Page scroll sets
      // panel.scrollTop = scrollY + offset, so a nudge you gave one column with its
      // OWN scrollbar is preserved as the page scrolls (the three stay aligned the
      // way you set them). A 'syncing' flag distinguishes our programmatic scrolls
      // from your manual ones so manual moves update the offset, ours don't.
      const offsets = new WeakMap(); // panel -> offset px
      let syncing = false;

      window.addEventListener('scroll', () => {
        if (!active()) return;
        syncing = true;
        for (const p of visiblePanels()) {
          const off = offsets.get(p) || 0;
          p.scrollTop = Math.max(0, window.scrollY + off);
        }
        // Release the flag after the panel 'scroll' events have fired.
        requestAnimationFrame(() => { syncing = false; });
      }, { passive: true });

      // A panel scrolled by YOU (not by our sync) records a new offset = where it
      // is now minus where page-scroll would have put it.
      for (const p of cols.map((c) => c.querySelector('.dscroll'))) {
        p.addEventListener('scroll', () => {
          if (syncing || !active()) return;
          offsets.set(p, p.scrollTop - window.scrollY);
        }, { passive: true });
      }

      // Wheel over the columns scrolls the PAGE (which drives the panels via the
      // scroll handler above) — so wheel and the page scrollbar stay in sync.
      group.addEventListener('wheel', (e) => {
        if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        window.scrollBy(0, e.deltaY);
      }, { passive: false });

      // (Re)size the driver when this detail becomes active (images may still be
      // loading, so also recompute on load).
      window.addEventListener('hashchange', () => { if (active()) { window.scrollTo(0, 0); sizeDriver(); } });
      window.addEventListener('load', () => { if (active()) sizeDriver(); });
    });
  </script>
</body></html>`;

  writeFileSync(OUT, html, 'utf8');
  return OUT;
}

const out = build();
if (out) {
  // eslint-disable-next-line no-console
  console.log(`[live-gallery] wrote ${out}`);
  if (process.argv.includes('--open')) {
    // Windows: `start`; mac: `open`; linux: `xdg-open`.
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', out]]
      : process.platform === 'darwin' ? ['open', [out]]
      : ['xdg-open', [out]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  }
} else {
  // eslint-disable-next-line no-console
  console.log('[live-gallery] no live-visual-run captures found — nothing to build');
}

export { build };
