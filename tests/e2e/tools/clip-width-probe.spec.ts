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
    await page.evaluate((html: string) => {
      const host = document.createElement('div');
      host.className = 'clip-body';
      host.id = '__clipw';
      host.innerHTML = html;
      document.body.innerHTML = '';
      document.body.appendChild(host);
    }, bodyHtml);
    await page.waitForTimeout(1_500);

    const report = await page.evaluate(() => {
      const lines: string[] = [];
      const root = document.getElementById('__clipw')!;
      lines.push(`.clip-body width: ${Math.round(root.getBoundingClientRect().width)}px`);

      // Text-bearing elements that render absurdly narrow = the collapse.
      const narrow = Array.from(root.querySelectorAll<HTMLElement>('*'))
        .map(e => ({ e, r: e.getBoundingClientRect(), t: (e.textContent ?? '').trim().length }))
        .filter(x => x.t > 60 && x.r.width > 0 && x.r.width < 120)
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
