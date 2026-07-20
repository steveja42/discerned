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
    const [, site, , type] = m;
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
  // Detail column: each column scrolls independently (in .dscroll), and the page
  // scrolls too — see the .detail-cols .dscroll CSS.
  const detailCol = (label, list) => {
    const imgs = list.sort().map((f) => `<img src="./${f}" alt="${f}" loading="lazy">`).join('\n');
    return `<div class="col"><div class="col-label">${label}${list.length ? '' : ' <em>(none)</em>'}</div><div class="dscroll">${imgs}</div></div>`;
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
      </div>
      <div class="detail-cols">
        ${detailCol('source (live site)', e.source)}
        ${detailCol('clip (/clips)', e.clip)}
        ${detailCol('cast (/discerns)', e.cast)}
      </div>
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
    display: flex; align-items: baseline; gap: 12px; border-bottom: 2px solid #8884; margin-bottom: 12px; z-index: 1; }
  .detail-bar h2 { font-size: 18px; margin: 0; text-transform: capitalize; }
  .back { font-size: 14px; color: #4a90d9; border: 1px solid #4a90d966; border-radius: 6px; padding: 4px 10px; }
  .back:hover { background: #4a90d922; }
  .detail-cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; align-items: start; }
  .detail-cols .col-label { font-size: 13px; margin-bottom: 6px; }
  /* Each column is a viewport-tall scroll panel. Two ways to scroll:
     - a wheel/trackpad gesture anywhere over the columns scrolls ALL THREE
       together (one motion — read straight down through source+clip+cast at once),
       wired up in the script below;
     - each panel's OWN scrollbar nudges just that one, to line it up with the
       others. Height fills the screen under the sticky detail-bar (~64px). */
  .detail-cols .dscroll { height: calc(100vh - 90px); overflow: auto;
    border: 1px solid #8883; border-radius: 6px; background: #7771; overscroll-behavior: contain; }
  .detail-cols img { display: block; width: 100%; height: auto; }
</style></head>
<body>
  <div id="overview">
    <h1>Live visual captures — source · clip · cast</h1>
    <p class="hint">Click a site to expand all three images full-page. Newest run first. Generated ${new Date().toLocaleString()}.</p>
    ${rows}
  </div>
  ${details}
  <script>
    // Synced scroll: a wheel gesture over a detail's columns scrolls all three
    // panels together (one motion through source/clip/cast). Each panel's own
    // scrollbar still moves just that one, for fine alignment.
    document.querySelectorAll('.detail-cols').forEach((group) => {
      const panels = [...group.querySelectorAll('.dscroll')];
      group.addEventListener('wheel', (e) => {
        // Let horizontal / zoom gestures pass through; only hijack vertical.
        if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        for (const p of panels) p.scrollTop += e.deltaY;
      }, { passive: false });
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
