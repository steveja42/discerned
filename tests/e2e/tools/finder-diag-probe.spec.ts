// One-off diagnostic probe for the corpus-sweep finder mis-picks (businessinsider
// hero-only, letterboxd review-card, timesofindia sponsored tail, homedepot
// near-empty). For each URL it loads the LIVE page in the warm Profile 3 and dumps
// the top candidate content-blocks the way findContentBlockByLayout sees them —
// tag, class, textLen, area, linkRatio, #p, #img — plus whether the real body
// text is present in the DOM. This tells us if each is a FINDER mis-pick (content
// present but a wrong block wins) vs a bot-gate/lazy-load (content absent).
//
// Run: DIAG=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//   --project=finder-diag-probe   (from repo root, chrome fully closed)

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const TARGETS: Record<string, string> = {
  businessinsider: 'https://www.businessinsider.com/great-coding-reset-ai-software-engineering-2026-7',
  letterboxd: 'https://letterboxd.com/film/parasite-2019/',
  timesofindia: 'https://timesofindia.indiatimes.com/technology/tech-news/apple-may-launch-its-rival-to-meta-ray-ban-smart-glass-at-wwdc-2027-report/articleshow/132654734.cms',
  homedepot: 'https://www.homedepot.com/p/Milwaukee-M18-18V-Lithium-Ion-Cordless-SAWZALL-Reciprocating-Saw-Tool-Only-2621-20/205482388',
  zillow: 'https://www.zillow.com/homedetails/2049-SE-157th-Ave-Portland-OR-97233/53862003_zpid/',
};

test.describe.configure({ mode: 'serial' });

test('finder diagnostics for the 4 mis-pick domains', async () => {
  test.skip(!process.env.DIAG, 'set DIAG=1 to run the finder diagnostic probe');
  test.setTimeout(300_000);

  const only = process.env.DIAG_ONLY
    ? new Set(process.env.DIAG_ONLY.split(',').map(s => s.trim()))
    : null;
  const entries = Object.entries(TARGETS).filter(([n]) => !only || only.has(n));

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR ??
    resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.DIAG_HEADED,
    clearSwCacheForRawDir: true,
  });

  mkdirSync(resolve(__dirname, '..', '..', '..', 'test-output'), { recursive: true });
  const out: string[] = [];

  try {
    for (const [name, url] of entries) {
      const page = await ctx.newPage();
      out.push(`\n════════ ${name} ════════\n${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(4_000);
        // Scroll to trigger lazy body/recommendations, then back to top.
        await page.evaluate(async () => {
          for (let y = 0; y < 6000; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(2_000);
        const finalUrl = page.url();
        if (finalUrl !== url) out.push(`⟳ REDIRECTED → ${finalUrl}`);

        const diag = await page.evaluate(() => {
          const SKIP = new Set(['script','style','noscript','nav','header','footer','aside','svg','path','button','input','select','textarea','form','iframe','p','li','blockquote','h1','h2','h3','h4','h5','h6','pre','code']);
          const rows: { tag: string; cls: string; textLen: number; visLen: number; area: number; linkRatio: number; p: number; img: number; score: number }[] = [];
          for (const el of Array.from(document.body.querySelectorAll('*'))) {
            const tag = el.tagName.toLowerCase();
            if (SKIP.has(tag)) continue;
            const r = el.getBoundingClientRect();
            const text = (el.textContent ?? '').trim();
            if (text.length < 150) continue;
            const visLen = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().length; // VISIBLE text only
            const linkText = Array.from(el.querySelectorAll('a')).map(a => (a.textContent ?? '').trim()).join(' ');
            const linkRatio = linkText.length / Math.max(text.length, 1);
            const pCount = el.querySelectorAll('p, blockquote, li, h1, h2, h3, h4').length;
            const imgCount = el.querySelectorAll('img').length;
            const area = r.width * r.height;
            const score = (Math.sqrt(area) + text.length + pCount * 50 + imgCount * 20) * (1 - linkRatio);
            rows.push({ tag, cls: (el.className || '').toString().slice(0, 40), textLen: text.length, visLen, area: Math.round(area), linkRatio: Math.round(linkRatio * 100) / 100, p: pCount, img: imgCount, score: Math.round(score) });
          }
          rows.sort((a, b) => b.score - a.score);
          // Body-presence probe: how much prose is on the page total?
          const bodyProse = Array.from(document.querySelectorAll('p')).map(p => (p.textContent ?? '').trim()).filter(t => t.length > 40);
          // For the top-scored blocks, report VISIBILITY: a block scored high but
          // positioned off-screen / display:none / collapsed is a hidden panel the
          // finder shouldn't pick (Zillow keeps a hidden search-results list in the
          // DOM beside the visible property detail).
          const vis = rows.slice(0, 6).map(r => {
            const el = Array.from(document.body.querySelectorAll('*')).find(e =>
              (e.className || '').toString().slice(0, 40) === r.cls && (e.textContent ?? '').trim().length === r.textLen);
            if (!el) return `${r.cls.slice(0,24)}: (not re-found)`;
            const rc = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const onScreen = rc.bottom > 0 && rc.top < (window.innerHeight * 3) && rc.right > 0 && rc.left < window.innerWidth;
            return `${(r.cls||'(no-cls)').slice(0,24)}: box=${Math.round(rc.width)}x${Math.round(rc.height)} top=${Math.round(rc.top)} vis=${cs.visibility} disp=${cs.display} opacity=${cs.opacity} onScreen=${onScreen}`;
          });
          return { top: rows.slice(0, 12), vis, proseParagraphs: bodyProse.length, proseChars: bodyProse.join(' ').length, totalBodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().length };
        });

        // TOI "Latest Mobiles" widget structural dump — walk up from the heading
        // and describe how the card grid relates (child vs following sibling) so
        // the removal selector can be made robust to this LOAD's actual DOM.
        if (name === 'zillow') {
          const zdump = await page.evaluate(() => {
            const lines: string[] = [];
            // Where does the property-detail text live vs the SRP list? Find the
            // tightest element containing distinctive property-detail phrases and
            // report its box + on-screen state, and the same for the SRP list.
            const findTight = (needle: string) => {
              const all = Array.from(document.querySelectorAll('*')).filter(e =>
                (e.textContent ?? '').includes(needle));
              // tightest = the one with the smallest textContent that still has it
              all.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length);
              return all[0] ?? null;
            };
            const describe = (label: string, el: Element | null) => {
              if (!el) { lines.push(`${label}: NOT FOUND in DOM`); return; }
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
              lines.push(`${label}: <${el.tagName.toLowerCase()} class="${(el.className||'').toString().slice(0,30)}"> box=${Math.round(r.width)}x${Math.round(r.height)} top=${Math.round(r.top)} left=${Math.round(r.left)} vis=${cs.visibility} disp=${cs.display} opacity=${cs.opacity} onScreen=${onScreen}`);
            };
            // Property-detail signals (a single-listing page). Try a few.
            describe('detail "Sold" price banner', findTight('Zestimate'));
            describe('detail "Price history"', findTight('Price history'));
            describe('detail "What\'s special"', findTight("What's special"));
            describe('detail address heading', findTight('157th Ave'));
            // SRP signals.
            describe('SRP "results" heading', findTight('results'));
            describe('SRP "Recently Sold Homes"', findTight('Recently Sold Homes'));
            // What is actually at the top of the viewport? (null-safe)
            const at = (x: number, y: number) => {
              const e = document.elementFromPoint(x, y);
              return e ? `<${e.tagName.toLowerCase()} class="${(e.className || '').toString().slice(0, 40)}">` : '(none)';
            };
            lines.push(`element at viewport (640,200): ${at(640, 200)}`);
            lines.push(`element at viewport (640,500): ${at(640, 500)}`);
            return lines.join('\n');
          });
          out.push('ZILLOW DETAIL-vs-SRP:\n' + zdump);
        }
        if (name === 'timesofindia') {
          const widgetDump = await page.evaluate(() => {
            const labels = ['Latest Mobiles', 'Photostories', 'Hot Picks', 'Top Trending'];
            const out: string[] = [];
            for (const label of labels) {
              const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div,a'))
                .filter(e => (e.textContent ?? '').trim().replace(/\s+/g, ' ') === label);
              if (!heads.length) { out.push(`── ${label}: (heading not found)`); continue; }
              const h = heads[0];
              out.push(`── ${label}: heading <${h.tagName.toLowerCase()}>`);
              let el: Element | null = h;
              for (let i = 0; i < 6 && el && el !== document.body; i++) {
                const p: Element | null = el.parentElement;
                if (!p) break;
                const hrefs = Array.from(p.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).getAttribute('href') ?? '');
                const host = hrefs.map(u => { try { return new URL(u, location.href).host; } catch { return ''; } }).filter(Boolean);
                const topHost = [...new Set(host)].slice(0, 2).join(',');
                const imgs = p.querySelectorAll('img').length;
                const txt = (p.textContent ?? '').replace(/\s+/g, ' ').trim().length;
                out.push(`    up[${i}] <${p.tagName.toLowerCase()} class="${(p.className||'').toString().slice(0,34)}"> a=${hrefs.length} img=${imgs} txt=${txt} hosts=${topHost}`);
                el = p;
              }
            }
            return out.join('\n');
          });
          out.push('TOI TAIL WIDGET STRUCTURES:\n' + widgetDump);
        }

        out.push(`prose <p>(>40ch): ${diag.proseParagraphs}  proseChars: ${diag.proseChars}  totalBodyText: ${diag.totalBodyText}`);
        if (diag.vis) { out.push('visibility of top blocks:'); for (const v of diag.vis) out.push('  ' + v); }
        out.push('top blocks (score | tag.cls | textLen | visLen | area | linkRatio | #p | #img):');
        for (const b of diag.top) {
          out.push(`  ${String(b.score).padStart(8)} | ${(b.tag + '.' + b.cls).padEnd(46)} | ${String(b.textLen).padStart(6)} | ${String(b.visLen).padStart(6)} | ${String(b.area).padStart(9)} | ${String(b.linkRatio).padStart(4)} | ${String(b.p).padStart(3)} | ${String(b.img).padStart(3)}`);
        }

        // Actually run the extension capture so we see what bodyHtml survives.
        // The diag array rides back ON the result message (module-level in the
        // content script → crosses the isolated-world boundary; a window global
        // would NOT be visible from this main-world evaluate).
        const res = (await page.evaluate(async () => new Promise<{ capture?: Record<string, unknown>; diag?: string[]; __err?: string }>((resolve) => {
          const t = setTimeout(() => resolve({ __err: 'capture timeout' }), 40_000);
          const on = (e: MessageEvent) => {
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(t); window.removeEventListener('message', on);
            if (e.data.error) resolve({ __err: e.data.error });
            else resolve({ capture: e.data.capture, diag: e.data.diag });
          };
          window.addEventListener('message', on);
          window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
        }))) as { capture?: Record<string, unknown>; diag?: string[]; __err?: string };
        if (res.__err) { out.push(`CAPTURE ERROR: ${res.__err}`); }
        else {
          const cap = res.capture ?? {};
          const body = (cap.bodyHtml as string) ?? '';
          const bodyText = (cap.bodyText as string) ?? '';
          out.push(`CAPTURED: bodyHtml ${body.length} chars, bodyText ${bodyText.length} chars, title="${(cap.title as string ?? '').slice(0,60)}"`);
          out.push(`  bodyText head: ${bodyText.replace(/\s+/g,' ').slice(0, 240)}`);
          const diagLines = res.diag ?? [];
          out.push('  pipeline stages: ' + (diagLines.length ? '' : '(none captured)'));
          for (const d of diagLines) out.push('    ' + d);
          writeFileSync(resolve(__dirname, '..', '..', '..', 'test-output', `finder-diag-${name}-body.html`), body, 'utf8');
        }
      } catch (e) {
        out.push(`ERROR: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await ctx.close();
  }

  const report = out.join('\n');
  writeFileSync(resolve(__dirname, '..', '..', '..', 'test-output', 'finder-diag.txt'), report + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});
