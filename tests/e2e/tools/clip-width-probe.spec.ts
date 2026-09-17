// Why does a rendered clip collapse into ultra-narrow columns?
//
// Lemmy's nested comment replies render in /clips as ~1-character-wide vertical
// strips even though the CAPTURED html is structurally fine (nested
// <ul class="comments"><li class="comment">, ~824px wide on the live page).
// That means the defect is in how .clip-body STYLES the captured markup, not in
// capture — so this probe renders a captured clip in the real web app and
// reports the narrowest text-bearing elements plus the computed styles and the
// ancestor chain responsible for the width.
//
// Run (needs the sweep to have captured the domain first, so its bodyHtml is in
// test-output/corpus-sweep-run/<domain>--clip.html):
//   CLIPW=1 CLIPW_DOMAIN=lemmy-thread pnpm exec playwright test \
//     -c tests/e2e/playwright.config.ts --project=clip-width-probe

import { test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('which elements collapse in the rendered clip?', async () => {
  test.skip(!process.env.CLIPW, 'set CLIPW=1 to run the clip-width probe');
  test.setTimeout(180_000);

  const domain = process.env.CLIPW_DOMAIN ?? 'lemmy-thread';
  const htmlPath = process.env.CLIPW_HTML
    ?? resolve(__dirname, '..', '..', '..', 'test-output', `finder-diag-${domain}-body.html`);
  const bodyHtml = readFileSync(htmlPath, 'utf8');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const out: string[] = [];

  try {
    // Render the captured bodyHtml through the REAL /clips styles by loading the
    // app's stylesheet into a bare page — same CSS, no bridge plumbing needed.
    await page.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    // CLIPW_WIDTH constrains the host to the column width the defect was seen
    // at. This matters: the sweep renders .clip-body in a ~610px detail panel,
    // and a table/ribbon only collapses when the column is too narrow for its
    // columns — so probing at the full 1280px viewport reports "nothing is
    // narrow" for a clip that is visibly broken in the sweep image (measured on
    // zenodo and steam, 2026-09-16).
    await page.evaluate(({ html, width }: { html: string; width: number }) => {
      const host = document.createElement('div');
      host.className = 'clip-body';
      host.id = '__clipw';
      if (width > 0) { host.style.width = `${width}px`; host.style.maxWidth = `${width}px`; }
      host.innerHTML = html;
      document.body.innerHTML = '';
      document.body.appendChild(host);
    }, { html: bodyHtml, width: Number(process.env.CLIPW_WIDTH ?? 0) });
    await page.waitForTimeout(1_500);

    const report = await page.evaluate(() => {
      const lines: string[] = [];
      const root = document.getElementById('__clipw')!;
      lines.push(`.clip-body width: ${Math.round(root.getBoundingClientRect().width)}px`);

      // Text-bearing elements that render absurdly narrow = the collapse.
      //
      // The length floor must stay LOW. It was `t > 60`, which is right for
      // Lemmy's paragraph-length comments but silently blind to the squeezed
      // LABEL shape: last.fm's "Thom Yorke" (10 chars) renders one word per
      // line beside a 103px image in a nowrap flex row, and the probe reported
      // "0 narrow elements" for a clip that is visibly broken (2026-09-16).
      // Require only that the text cannot fit — narrower than roughly the
      // longest word it holds — so a short label counts too.
      const longestWord = (s: string) => s.trim().split(/\s+/)
        .reduce((n, w) => Math.max(n, w.length), 0);
      const narrow = Array.from(root.querySelectorAll<HTMLElement>('*'))
        .map(e => ({ e, r: e.getBoundingClientRect(), s: (e.textContent ?? '').trim() }))
        .filter(x => x.s.length >= 6 && x.r.width > 0 && x.r.width < 120
          // ~7px per char is a conservative lower bound for the clip's serif
          // body font; a box narrower than its longest word must break it.
          && (x.s.length > 60 || x.r.width < longestWord(x.s) * 7))
        .map(x => ({ e: x.e, r: x.r, t: x.s.length }))
        .sort((a, b) => a.r.width - b.r.width);
      lines.push(`text elements narrower than 120px: ${narrow.length}`);

      for (const { e, r, t } of narrow.slice(0, 5)) {
        const cs = getComputedStyle(e);
        lines.push(`\n  <${e.tagName.toLowerCase()} class="${(e.className || '').toString().slice(0, 40)}">`
          + ` w=${Math.round(r.width)} textLen=${t}`);
        lines.push(`     display=${cs.display} float=${cs.float} width=${cs.width} flex=${cs.flex} writingMode=${cs.writingMode}`);
        // Walk up: the first ancestor that is itself narrow is the culprit.
        let cur: Element | null = e.parentElement;
        for (let i = 0; cur && cur !== root.parentElement && i < 8; i++) {
          const cr = cur.getBoundingClientRect();
          const ccs = getComputedStyle(cur);
          lines.push(`     ↑[${i}] <${cur.tagName.toLowerCase()} class="${(cur.className || '').toString().slice(0, 34)}">`
            + ` w=${Math.round(cr.width)} display=${ccs.display} width=${ccs.width} flex=${ccs.flex} ml=${ccs.marginLeft}`);
          cur = cur.parentElement;
        }
      }

      // TABLE / RIBBON census. A record table (zenodo's citations, lastfm's
      // stat row) collapses differently from Lemmy's nested lists: the element
      // is not narrow, its CELLS are, so the "narrow text element" test above
      // misses it entirely. Report the narrowest cells per table and whether
      // the table overflows its column, which is what "one-character columns"
      // in a sweep verdict actually looks like.
      const tables = Array.from(root.querySelectorAll<HTMLElement>('table'));
      lines.push(`\n<table> count: ${tables.length}`);
      const rootW = root.getBoundingClientRect().width;
      for (const [i, tb] of tables.slice(0, 6).entries()) {
        const tr = tb.getBoundingClientRect();
        const cells = Array.from(tb.querySelectorAll<HTMLElement>('td, th'))
          .map(c => ({ w: c.getBoundingClientRect().width, t: (c.textContent ?? '').trim() }))
          .filter(c => c.t.length > 0);
        if (cells.length === 0) { lines.push(`  [${i}] no cells`); continue; }
        const widths = cells.map(c => c.w).sort((a, b) => a - b);
        const tight = cells.filter(c => c.w > 0 && c.w < 40 && c.t.length > 3);
        lines.push(`  [${i}] table w=${Math.round(tr.width)} (col ${Math.round(rootW)})`
          + `${tr.width > rootW + 1 ? ' OVERFLOWS' : ''} cells=${cells.length}`
          + ` cellW ${Math.round(widths[0])}..${Math.round(widths[widths.length - 1])}px`
          + ` squeezed(<40px w/ text)=${tight.length}`);
        for (const c of tight.slice(0, 4)) {
          lines.push(`       w=${Math.round(c.w)}px text="${c.t.slice(0, 30)}"`);
        }
      }

      // Nested-list census (Lemmy's comment tree shape).
      const uls = Array.from(root.querySelectorAll<HTMLElement>('ul'));
      lines.push(`\n<ul> count: ${uls.length}`);
      const byDepth = new Map<number, { n: number; minW: number; maxW: number }>();
      for (const ul of uls) {
        let d = 0, cur: Element | null = ul.parentElement;
        while (cur && cur !== root) { if (cur.tagName === 'UL') d++; cur = cur.parentElement; }
        const w = Math.round(ul.getBoundingClientRect().width);
        const e = byDepth.get(d) ?? { n: 0, minW: 1e9, maxW: 0 };
        e.n++; e.minW = Math.min(e.minW, w); e.maxW = Math.max(e.maxW, w);
        byDepth.set(d, e);
      }
      lines.push('rendered <ul> width by nesting depth:');
      for (const [d, v] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`   depth ${d}: n=${v.n}  width ${v.minW}..${v.maxW}px`);
      }
      return lines.join('\n');
    });

    out.push(report);
    mkdirSync(resolve(__dirname, '..', '..', '..', 'test-output'), { recursive: true });
    await page.screenshot({
      path: resolve(__dirname, '..', '..', '..', 'test-output', `clipw-${domain}.png`),
      fullPage: false,
    }).catch(() => undefined);
  } finally {
    await browser.close();
  }

  const p = resolve(__dirname, '..', '..', '..', 'test-output', `clip-width-${domain}.txt`);
  writeFileSync(p, out.join('\n'), 'utf8');
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
  // eslint-disable-next-line no-console
  console.log(`\n→ ${p}`);
});
