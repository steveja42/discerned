// Live-page diagnostic probe for the corpus sweep. Two modes, one harness (warm
// Profile 3 + PerimeterX auto-solve + artifact dump to test-output/):
//
// MODE 1 — finder diagnostics (default). For each URL it dumps the top candidate
//   content-blocks the way findContentBlockByLayout sees them — tag, class,
//   textLen, visLen, area, linkRatio, #p, #img — plus whether the real body text
//   is present. Distinguishes a FINDER mis-pick (content present, wrong block
//   wins) from a bot-gate/lazy-load (content absent).
//     DIAG=1 [DIAG_ONLY=haaretz,rfc-editor] [DIAG_HEADED=1]
//
// MODE 2 — picker diagnostics (DIAG_MODE=picker). Answers why a
//   `discover-article-urls` seed reported "no link matched picker", which
//   conflates four causes: the hub never rendered (bot wall), the site MOVED
//   (msnbc.com → ms.now, phys.org → techxplore.com — the regex can then never
//   match), the URL shape changed (CBC's ids went -1.N → -9.N), or minText
//   rejected every match (ms.now's article links are image-wrapped, 0-char text).
//   Reports final URL, <title>, body head, anchor/regex/minText counts, real
//   in-domain deep links, a screenshot, and a verdict.
//     DIAG=1 DIAG_MODE=picker [DIAG_ONLY=cbc] [DIAG_HEADED=1] [DIAG_WAIT=60]
//
//   Picker mode reads its seeds FROM discover-article-urls.spec.ts, so there is
//   no second copy of the target list to drift (an earlier standalone probe held
//   a stale lemmy hub URL and probed the wrong page).
//
// Shared options: DIAG_GAP=<seconds> paces between sites — hitting ~10 domains
// back-to-back from one IP is itself a bot signal and Cloudflare starts serving
// "Just a moment…" to the LATER ones. DIAG_WAIT=<seconds> holds each page open
// so a human can dismiss a consent banner / solve a gate in a headed run.
//
// Run from the repo root with Chrome fully closed (the profile is locked):
//   DIAG=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=finder-diag-probe

import { test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

/** A discovery seed, parsed out of discover-article-urls.spec.ts (single source
 *  of truth for hub URLs + link pickers — see the header note). */
interface PickerSeed { name: string; seedUrl: string; hrefRe: string; minText: number }

function loadPickerSeeds(): PickerSeed[] {
  const src = readFileSync(resolve(__dirname, 'discover-article-urls.spec.ts'), 'utf8');
  const seeds: PickerSeed[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*\{ name: '([^']+)', seedUrl: '([^']+)', hrefRe: '((?:[^'\\]|\\.)*)'/.exec(line);
    if (!m) continue;
    // `direct: true` seeds have no picker — nothing to diagnose.
    if (/direct:\s*true/.test(line)) continue;
    const minTextM = /minText:\s*(\d+)/.exec(line);
    seeds.push({
      name: m[1],
      seedUrl: m[2],
      // The TS source escapes backslashes for the string literal; undo that to
      // get the pattern `new RegExp(...)` actually receives.
      hrefRe: JSON.parse(`"${m[3]}"`) as string,
      minText: minTextM ? Number(minTextM[1]) : 15,
    });
  }
  return seeds;
}

const TARGETS: Record<string, string> = {
  businessinsider: 'https://www.businessinsider.com/great-coding-reset-ai-software-engineering-2026-7',
  letterboxd: 'https://letterboxd.com/film/parasite-2019/',
  timesofindia: 'https://timesofindia.indiatimes.com/technology/tech-news/apple-may-launch-its-rival-to-meta-ray-ban-smart-glass-at-wwdc-2027-report/articleshow/132654734.cms',
  homedepot: 'https://www.homedepot.com/p/Milwaukee-M18-18V-Lithium-Ion-Cordless-SAWZALL-Reciprocating-Saw-Tool-Only-2621-20/205482388',
  zillow: 'https://www.zillow.com/homedetails/2049-SE-157th-Ave-Portland-OR-97233/53862003_zpid/',
  walmart: 'https://www.walmart.com/ip/Mobil-1-High-Mileage-Full-Synthetic-Motor-Oil-5W-30-5-Quart/17018131',
  etsy: 'https://www.etsy.com/listing/547491922/leather-walletwalletman-leather',
  imdb: 'https://www.imdb.com/title/tt0111161/',
  devto: 'https://dev.to/francistrdev/choose-your-burden-4dgl',
  yelp: 'https://www.yelp.com/biz/lalibela-ethiopian-restaurant-portland?osq=Ethiopian',
  // Phase 4.4 sweep mis-picks (2026-07-29).
  haaretz: 'https://www.haaretz.com/gaza/2026-07-26/ty-article/al-jazeera-reportedly-ends-contracts-of-over-20-gazan-journalists/0000019f-9eeb-df42-a1df-fffb994d0000',
  folha: 'https://www1.folha.uol.com.br/mercado/2026/07/china-busca-lideranca-nas-regras-da-ia-com-nova-organizacao-internacional.shtml',
  'rfc-editor': 'https://www.rfc-editor.org/rfc/rfc9110.html',
  thehindu: 'https://www.thehindu.com/sci-tech/technology/moonshot-ai-releases-weights-for-kimi-k3-as-us-big-tech-firms-debate-open-weight-models/article71276300.ece',
  'lemmy-thread': 'https://lemmy.world/post/49992871',
  // Phase 4.5 sweep mis-pick (2026-07-30): the clip is the masthead badge + 3 nav
  // links while the page renders a full 3-book catalog TABLE. Table-shaped content
  // (no <p> prose) is the suspected finder blind spot.
  'librarything-catalog': 'https://www.librarything.com/catalog/Kardiaa',
};

test.describe.configure({ mode: 'serial' });

test('live-page diagnostics (finder / picker)', async () => {
  test.skip(!process.env.DIAG, 'set DIAG=1 to run the diagnostic probe');

  const pickerMode = process.env.DIAG_MODE === 'picker';
  const pickerSeeds = pickerMode ? loadPickerSeeds() : [];
  const seedByName = new Map(pickerSeeds.map(s => [s.name, s]));

  const only = process.env.DIAG_ONLY
    ? new Set(process.env.DIAG_ONLY.split(',').map(s => s.trim()))
    : null;
  const entries: Array<[string, string]> = pickerMode
    ? pickerSeeds.filter(s => !only || only.has(s.name)).map(s => [s.name, s.seedUrl])
    : Object.entries(TARGETS).filter(([n]) => !only || only.has(n));

  const waitSecs = Number(process.env.DIAG_WAIT ?? 0);
  const gapSecs = Number(process.env.DIAG_GAP ?? 0);
  test.setTimeout(entries.length * (45_000 + (waitSecs + gapSecs) * 1_000) + 120_000);

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
    let firstSite = true;
    for (const [name, url] of entries) {
      // Pace between sites (DIAG_GAP). An unpaced sweep of ~10 domains from one
      // IP got the LAST three Cloudflare-challenged while earlier ones loaded.
      if (!firstSite && gapSecs > 0) {
        // eslint-disable-next-line no-console
        console.log(`   … pausing ${gapSecs}s before ${name} (avoid rate-limit)`);
        await new Promise(r => setTimeout(r, gapSecs * 1_000));
      }
      firstSite = false;
      const page = await ctx.newPage();
      const seed = seedByName.get(name);
      out.push(`\n════════ ${name} ════════\n${url}`
        + (seed ? `\n  hrefRe: ${seed.hrefRe}   minText: ${seed.minText}` : ''));
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(4_000);
        // DIAG_WAIT holds the page so a human can clear a gate in a headed run.
        // Polls meanwhile and stops early once the page looks alive, so a merely
        // slow site costs no clicks.
        if (waitSecs > 0) {
          // eslint-disable-next-line no-console
          console.log(`   ⏸ ${name}: holding up to ${waitSecs}s — clear anything blocking the page…`);
          const deadline = Date.now() + waitSecs * 1_000;
          while (Date.now() < deadline) {
            const alive = await page.evaluate(
              () => document.querySelectorAll('a[href]').length,
            ).catch(() => 0);
            if (alive >= 20) break;
            await page.waitForTimeout(2_000);
          }
        }
        // Auto-solve a PerimeterX 'Press & Hold' gate (walmart/etsy) so the probe
        // doesn't need the user to click. Retry a few times.
        for (let attempt = 0; attempt < 3; attempt++) {
          const blocked = await page.evaluate(() => {
            const t = (document.body?.innerText ?? '').toLowerCase();
            return t.length < 40 || /press\s*&?\s*hold|robot or human|make sure you'?re a human/.test(t);
          }).catch(() => false);
          if (!blocked) break;
          for (const root of [page, ...page.frames()]) {
            for (const sel of ['#px-captcha', '[aria-label*="Press" i]', 'text=/press\\s*&?\\s*hold/i']) {
              try {
                const loc = root.locator(sel).first();
                if (!(await loc.count())) continue;
                const box = await loc.boundingBox({ timeout: 800 }).catch(() => null);
                if (!box) continue;
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.down(); await page.waitForTimeout(8_000); await page.mouse.up();
              } catch { /* next */ }
            }
          }
          await page.waitForTimeout(2_000);
        }
        // Scroll to trigger lazy body/recommendations, then back to top.
        await page.evaluate(async () => {
          for (let y = 0; y < 6000; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(2_000);
        const finalUrl = page.url();
        if (finalUrl !== url) out.push(`⟳ REDIRECTED → ${finalUrl}`);

        // ── MODE 2: picker diagnostics ────────────────────────────────────
        if (pickerMode && seed) {
          const pd = await page.evaluate(({ hrefRe, minText }: { hrefRe: string; minText: number }) => {
            const re = new RegExp(hrefRe);
            const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
            const reMatch = anchors.filter(a => re.test(a.href));
            const passBoth = reMatch.filter(
              a => ((a.textContent ?? '').replace(/\s+/g, ' ').trim().length) >= minText);
            // Ground truth for writing a new regex: the real in-domain deep
            // links, with nav/section links filtered out.
            const host = location.hostname.replace(/^www\./, '');
            const seen = new Set<string>();
            const samples: string[] = [];
            for (const a of anchors) {
              let u: URL;
              try { u = new URL(a.href); } catch { continue; }
              if (!u.hostname.includes(host)) continue;
              if (u.pathname.split('/').filter(Boolean).length < 2) continue;
              if (seen.has(u.pathname)) continue;
              seen.add(u.pathname);
              const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
              if (last.length < 15 && !/\d/.test(last)) continue;
              const txt = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (samples.length < 12) samples.push(`${u.href}   [text ${txt.length}ch] "${txt.slice(0, 45)}"`);
            }
            return {
              title: document.title,
              bodyHead: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
              bodyLen: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
              anchors: anchors.length,
              reMatch: reMatch.length,
              passBoth: passBoth.length,
              reMatchSamples: reMatch.slice(0, 3)
                .map(a => `${a.href}  [text ${(a.textContent ?? '').trim().length}ch]`),
              samples,
            };
          }, { hrefRe: seed.hrefRe, minText: seed.minText });

          out.push(`  <title>: "${pd.title}"`);
          out.push(`  page body text: ${pd.bodyLen} chars   anchors: ${pd.anchors}`);
          out.push(`  body head: "${pd.bodyHead}"`);
          out.push(`  matched regex: ${pd.reMatch}    then passed minText: ${pd.passBoth}`);
          if (pd.bodyLen < 500) out.push('  ⇒ VERDICT: page never rendered (bot wall / empty shell)');
          else if (pd.anchors < 20) out.push('  ⇒ VERDICT: rendered but almost no links (JS-only feed?)');
          else if (pd.reMatch === 0) out.push('  ⇒ VERDICT: links present, REGEX IS WRONG (site moved? URL shape changed?)');
          else if (pd.passBoth === 0) out.push('  ⇒ VERDICT: regex matched but minText rejected every one');
          else out.push('  ⇒ VERDICT: would match now');
          if (pd.reMatchSamples.length) {
            out.push('  regex-matching hrefs:');
            pd.reMatchSamples.forEach(x => out.push(`     ${x}`));
          }
          out.push('  real in-domain deep links on the page:');
          pd.samples.forEach(x => out.push(`     ${x}`));
          await page.screenshot({
            path: resolve(__dirname, '..', '..', '..', 'test-output', `diag-picker-${name}.png`),
          }).catch(() => undefined);
          await page.close().catch(() => undefined);
          continue;
        }

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
        // Lemmy: nested replies render as ~1-character-wide vertical columns in
        // the clip. Dump the comment tree's indent mechanism — which element
        // carries the per-level offset, and how wide each nesting level is —
        // so we can tell a generic width fix from a per-site tagger.
        if (name === 'lemmy-thread') {
          const ldump = await page.evaluate(() => {
            const lines: string[] = [];
            const nodes = Array.from(document.querySelectorAll('[id^="comment-"]'));
            lines.push(`[id^="comment-"] nodes: ${nodes.length}`);
            // Depth = how many comment ancestors each has → the nesting level.
            const withDepth = nodes.map(n => {
              let d = 0, cur: Element | null = n.parentElement;
              while (cur && cur !== document.body) {
                if (cur.id?.startsWith('comment-')) d++;
                cur = cur.parentElement;
              }
              const r = n.getBoundingClientRect();
              return { n, d, w: Math.round(r.width), x: Math.round(r.left) };
            });
            const byDepth = new Map<number, { count: number; minW: number; maxW: number }>();
            for (const { d, w } of withDepth) {
              const e = byDepth.get(d) ?? { count: 0, minW: 1e9, maxW: 0 };
              e.count++; e.minW = Math.min(e.minW, w); e.maxW = Math.max(e.maxW, w);
              byDepth.set(d, e);
            }
            lines.push('width by nesting depth (live page):');
            for (const [d, v] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
              lines.push(`   depth ${d}: n=${v.count}  width ${v.minW}..${v.maxW}px`);
            }
            // The visual nesting is NOT nested #comment- ids — find what really
            // offsets a reply: group comments by their left edge (x), which is
            // the rendered indent, and report the class that carries it.
            const byX = new Map<number, number>();
            for (const { x } of withDepth) byX.set(x, (byX.get(x) ?? 0) + 1);
            lines.push('comments grouped by left edge (rendered indent):');
            for (const [x, n] of [...byX.entries()].sort((a, b) => a[0] - b[0])) {
              lines.push(`   x=${x}px : ${n} comment(s)`);
            }
            // For an indented one, which ancestor introduces the offset?
            const base = Math.min(...withDepth.map(w => w.x));
            const indented = withDepth.find(w => w.x > base + 4);
            if (indented) {
              lines.push(`\nindented comment (x=${indented.x}, base=${base}) — ancestors that add offset:`);
              let cur: Element | null = indented.n;
              for (let i = 0; cur && cur !== document.body && i < 10; i++) {
                const cs = getComputedStyle(cur);
                const r = cur.getBoundingClientRect();
                lines.push(`   [${i}] <${cur.tagName.toLowerCase()} class="${(cur.className || '').toString().slice(0, 50)}">`
                  + ` x=${Math.round(r.left)} w=${Math.round(r.width)} ml=${cs.marginLeft} pl=${cs.paddingLeft}`);
                cur = cur.parentElement;
              }
            } else {
              lines.push('\n(no comment is indented relative to the others — flat list)');
            }

            // What creates the indent on a deep comment?
            const deep = withDepth.sort((a, b) => b.d - a.d)[0];
            if (deep) {
              lines.push(`\nancestor chain of a depth-${deep.d} comment:`);
              let cur: Element | null = deep.n;
              for (let i = 0; cur && cur !== document.body && i < 14; i++) {
                const cs = getComputedStyle(cur);
                const r = cur.getBoundingClientRect();
                lines.push(`   [${i}] <${cur.tagName.toLowerCase()} class="${(cur.className || '').toString().slice(0, 45)}">`
                  + ` w=${Math.round(r.width)} ml=${cs.marginLeft} pl=${cs.paddingLeft} disp=${cs.display} flex=${cs.flex}`);
                cur = cur.parentElement;
              }
            }
            return lines.join('\n');
          });
          out.push(ldump);
        }
        if (name === 'yelp') {
          const ydump = await page.evaluate(() => {
            const lines: string[] = [];
            // Find the biz-detail overlay/lightbox vs the search list. Try known
            // Yelp anchors + any element holding the biz h1 + a modal/overlay role.
            const h1 = document.querySelector('h1');
            lines.push(`h1: ${h1 ? '"' + (h1.textContent ?? '').trim().slice(0, 50) + '"' : 'none'}`);
            for (const sel of ['[role="dialog"]', '[role="main"]', 'main', '[class*="lightbox" i]', '[class*="modal" i]', '[class*="overlay" i]', '[aria-modal="true"]', '[data-testid*="biz" i]', '[class*="biz-details" i]', '[class*="photoHeader" i]']) {
              const el = document.querySelector(sel);
              if (!el) { lines.push(`${sel}: (none)`); continue; }
              const t = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
              const hasBizH1 = el.querySelector('h1') ? 'HAS-h1' : 'no-h1';
              lines.push(`${sel}: ${hasBizH1} txt="${t.slice(0, 90)}"`);
            }
            // Where does the biz h1 live — walk its ancestry, report which ancestor
            // first ALSO contains the biz reviews (Reviews heading) but NOT the
            // search-list "Do you recommend this business?" text = the biz scope.
            const photoHeader = document.querySelector('[class*="photoHeader" i]');
            if (photoHeader) {
              let el: Element | null = photoHeader;
              for (let i = 0; i < 12 && el && el !== document.body; i++) {
                const p: Element | null = el.parentElement; if (!p) break;
                const t = ((p as HTMLElement).innerText ?? '');
                const hasReviews = /Recommended Reviews|Location & Hours|Amenities/i.test(t) ? '+BIZBODY' : '';
                const hasSearch = /Do you recommend this business\?|Best .* in .* — Last Updated/i.test(t) ? '+SEARCH' : '';
                const id = p.id ? ' id="' + p.id + '"' : '';
                const dt = p.getAttribute('data-testid'); const dts = dt ? ' data-testid="' + dt + '"' : '';
                lines.push(`  ph.up[${i}] <${p.tagName.toLowerCase()}${id}${dts} class="${(p.className||'').toString().slice(0,30)}"> txt=${t.replace(/\s+/g,' ').trim().length}${hasReviews}${hasSearch}`);
                el = p;
              }
            }
            return lines.join('\n');
          });
          out.push('YELP STRUCTURE:\n' + ydump);
        }
        if (name === 'etsy') {
          const edump = await page.evaluate(() => {
            const lines: string[] = [];
            for (const sel of ['.alp-primary', '.alp-secondary', '.alp-page', 'main', '[data-appears-component-name*="listing" i]', '[data-reviews]', '[data-review-region]', '[id*="reviews" i]']) {
              const el = document.querySelector(sel);
              if (!el) { lines.push(`${sel}: (none)`); continue; }
              const t = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
              const h1 = el.querySelector('h1');
              const price = /\$\d/.test(t) ? 'HAS-$' : 'no-$';
              lines.push(`${sel}: h1=${h1 ? '"' + (h1.textContent ?? '').trim().slice(0, 40) + '"' : 'none'} ${price} txt[0..120]="${t.slice(0, 120)}"`);
            }
            return lines.join('\n');
          });
          out.push('ETSY STRUCTURE:\n' + edump);
        }
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
            const labels = ['Trending Stories', 'Daily Puzzles', 'Trending in Tech', 'From around the web',
              'Subscribe to TOI', 'THE TIMES OF INDIA', 'Tech News', 'End of Article'];
            const out: string[] = [];
            for (const label of labels) {
              const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div,a,li'))
                .filter(e => (e.textContent ?? '').trim().replace(/\s+/g, ' ') === label);
              if (!heads.length) { out.push(`── "${label}": (not found)`); continue; }
              const h = heads[0];
              out.push(`── "${label}": <${h.tagName.toLowerCase()} class="${(h.className||'').toString().slice(0,30)}">`);
              let el: Element | null = h;
              for (let i = 0; i < 6 && el && el !== document.body; i++) {
                const p: Element | null = el.parentElement;
                if (!p) break;
                const hrefs = Array.from(p.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).getAttribute('href') ?? '');
                const host = hrefs.map(u => { try { return new URL(u, location.href).host; } catch { return ''; } }).filter(Boolean);
                const topHost = [...new Set(host)].slice(0, 2).join(',');
                const imgs = p.querySelectorAll('img').length;
                const txt = (p.textContent ?? '').replace(/\s+/g, ' ').trim().length;
                out.push(`    up[${i}] <${p.tagName.toLowerCase()} class="${(p.className||'').toString().slice(0,40)}"> a=${hrefs.length} img=${imgs} txt=${txt} hosts=${topHost}`);
                el = p;
              }
            }
            // How many article headlines (h1) are on the page? >1 = infinite-scroll appended next articles.
            const h1s = Array.from(document.querySelectorAll('h1')).map(h => (h.textContent ?? '').trim().slice(0, 60));
            out.push(`H1 headings on page (${h1s.length}): ${h1s.join(' || ')}`);
            // Walk up from the FIRST article <h1> to find the tightest single-article
            // scope (before it merges with sidebar / next article).
            const h1 = document.querySelector('h1');
            if (h1) {
              out.push('── first-article <h1> ancestry:');
              let el: Element | null = h1;
              for (let i = 0; i < 9 && el && el !== document.body; i++) {
                const p: Element | null = el.parentElement;
                if (!p) break;
                const txt = (p.textContent ?? '').replace(/\s+/g, ' ').trim().length;
                const hasRhs = p.querySelector('[class*="article_rhs" i]') ? ' +RHS' : '';
                const hasNav = p.querySelector('nav, [class*="navigation" i]') ? ' +NAV' : '';
                const nextArt = (p.textContent ?? '').includes('autonomous college') ? ' +NEXTART' : '';
                out.push(`    up[${i}] <${p.tagName.toLowerCase()} class="${(p.className||'').toString().replace(/\s+/g,' ').slice(0,40)}"> txt=${txt}${hasRhs}${hasNav}${nextArt}`);
                el = p;
              }
            }
            return out.join('\n');
          });
          out.push('TOI TAIL + HEADER STRUCTURES:\n' + widgetDump);
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
