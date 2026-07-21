#!/usr/bin/env node
// Manual headed pass for corpus-sweep domains that HARD-block automated loads
// (IP-level walls, 403 stubs, bot checks the passive headed retry can't clear).
// Opens each named domain in a VISIBLE window and WAITS for you to interact —
// solve the CAPTCHA / click through / dismiss the wall — then, once the page no
// longer looks like an interstitial, runs the SAME capture → render → score path
// the sweep uses (dev test bridge → /clips render → the mirrored heuristics) and
// writes a full scored score.json + source/clip images into
// test-output/corpus-sweep-run/ so they merge into the gallery exactly like a
// normal sweep row. If the block never clears within the per-site budget, it
// stays a skip and moves on.
//
// Requires: Chrome fully closed (single-instance lock on Profile 3), pnpm dev
// running (web app on :3000), and dist-test built. Run:
//   node tests/e2e/tools/sweep-headed-manual.mjs [name1,name2,...]
// Default domains: reuters,imdb,goodreads-book,nytimes,hackernews
//
// Per site: WAIT_MS (default 90s) for you to clear the block. Bump with
//   SWEEP_MANUAL_WAIT_MS=180000 for slower interaction.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(process.cwd());
const RAW = resolve(ROOT, '.vscode', 'browser-test-profiles', 'chrome');
const CORPUS = resolve(ROOT, 'tests', 'fixtures', 'corpus-domains.json');
const RUN_DIR = resolve(ROOT, 'test-output', 'corpus-sweep-run');
const WAIT_MS = Number(process.env.SWEEP_MANUAL_WAIT_MS || 90_000);

const want = (process.argv[2] || 'reuters,imdb,goodreads-book,nytimes,hackernews')
  .split(',').map(s => s.trim()).filter(Boolean);
const all = JSON.parse(readFileSync(CORPUS, 'utf8')).domains;
const targets = all.filter(d => want.includes(d.name));

// Same interstitial signature test the sweep uses, so we can tell when your
// interaction has actually cleared the block (page now has real content).
const INTERSTITIAL_SRC = `
  (function () {
    let t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try { const i = f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText || ''; if (i) t = (t + ' ' + i).trim(); } catch (e) {}
    }
    if (t.length < 20) return true;
    if (t.length > 1500) return false;
    const low = t.toLowerCase();
    const SIG = ['performing security verification','checking your browser','verify you are human','verifying you are human','enable javascript and cookies to continue','needs to review the security','attention required','ddos protection by','just a moment','are you a robot','unusual traffic','not a bot','access is temporarily restricted','we detected unusual activity','ray id','403 forbidden','403 error','access denied','access to this page has been denied','request blocked','you have been blocked','temporarily unavailable','rate limited'];
    return SIG.some(s => low.includes(s));
  })()
`;

function artPaths(name) {
  const p = (order, type) => resolve(RUN_DIR, `${name}--${order}-${type}.png`);
  return { source: p(1, 'source'), clip: p(2, 'clip'), score: resolve(RUN_DIR, `${name}--score.json`) };
}

// ── Scoring (kept in lock-step with helpers/sweepScorers.ts) ──────────────
// This is plain Node (.mjs) and can't import the TS scorer, so the four
// heuristics + composite are mirrored here. sweepScorers.ts is the SOURCE OF
// TRUTH — if THRESHOLDS / weights / CHROME_SWEEP_PHRASES / measureInPage change
// there, update this copy too (both are guarded only by eyeballing the gallery).
const CHROME_SWEEP_PHRASES = [
  'share this', 'save for later', 'sign up for our newsletter', 'subscribe to our newsletter',
  'never miss', 'directly to your inbox', 'add us on google', 'preferred source',
  'open comment sort options', 'show comments', 'load more comments', 'continue reading',
  'read more from', 'recommended for you', 'you might also like', 'trending now',
  'most popular', 'up next', 'related articles', 'advertisement', 'skip to content',
  'accept all cookies', 'manage cookies', 'we use cookies',
];
const THRESHOLDS = { textCoverageLow: 0.05, textCoverageHigh: 0.9, blankRatio: 0.35, aspectDistorted: 1, chromeHits: 3 };
const round = (n) => Math.round(n * 1000) / 1000;

// Runs INSIDE the page (serialised). Mirrors sweepScorers.measureInPage.
const MEASURE_SRC = `
  (function (clipBody, pageTextLen, chromePhrases) {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const clipText = norm(clipBody.innerText);
    const clipRect = clipBody.getBoundingClientRect();
    const clipHeight = clipRect.height;
    let blankPx = 0;
    const children = Array.from(clipBody.children);
    let cursor = clipRect.top;
    for (const c of children) {
      const r = c.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.top - cursor > 24) blankPx += r.top - cursor;
      cursor = Math.max(cursor, r.bottom);
    }
    if (clipRect.bottom - cursor > 24) blankPx += clipRect.bottom - cursor;
    let aspectDistorted = 0;
    const imgs = Array.from(clipBody.querySelectorAll('img'));
    for (const img of imgs) {
      if (!img.naturalWidth || !img.naturalHeight) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const naturalAR = img.naturalWidth / img.naturalHeight;
      const renderedAR = r.width / r.height;
      if (renderedAR / naturalAR > 2.2 || naturalAR / renderedAR > 2.2) aspectDistorted++;
    }
    const lower = clipText.toLowerCase();
    let chromeHits = 0;
    for (const p of chromePhrases) if (lower.includes(p)) chromeHits++;
    return { clipTextLen: clipText.length, pageTextLen, clipHeight, blankPx, imgTotal: imgs.length, aspectDistorted, chromeHits };
  })
`;

// Mirrors sweepScorers.computeScores.
function computeScores(m) {
  const textCoverage = m.pageTextLen > 0 ? m.clipTextLen / m.pageTextLen : 0;
  const blankRatio = m.clipHeight > 0 ? Math.min(1, m.blankPx / m.clipHeight) : 0;
  const flags = [];
  let textBad = 0;
  if (textCoverage < THRESHOLDS.textCoverageLow) {
    textBad = 1 - textCoverage / THRESHOLDS.textCoverageLow;
    flags.push(`text-coverage low (${(textCoverage * 100).toFixed(1)}%)`);
  } else if (textCoverage > THRESHOLDS.textCoverageHigh) {
    if (m.chromeHits > 0) {
      textBad = Math.min(1, (textCoverage - THRESHOLDS.textCoverageHigh) / (1 - THRESHOLDS.textCoverageHigh));
      flags.push(`text-coverage high (${(textCoverage * 100).toFixed(0)}% — chrome likely included)`);
    } else {
      const pct = textCoverage > 1.05 ? '≥100' : (textCoverage * 100).toFixed(0);
      flags.push(`text-coverage high (${pct}% — no chrome detected, likely healthy)`);
    }
  }
  const blankBad = Math.min(1, blankRatio / Math.max(THRESHOLDS.blankRatio, 0.001));
  if (blankRatio > THRESHOLDS.blankRatio) flags.push(`blank-space ${(blankRatio * 100).toFixed(0)}%`);
  const distortBad = Math.min(1, m.aspectDistorted / 4);
  if (m.aspectDistorted >= THRESHOLDS.aspectDistorted) flags.push(`${m.aspectDistorted} distorted image(s)`);
  const chromeBad = Math.min(1, m.chromeHits / 8);
  if (m.chromeHits >= THRESHOLDS.chromeHits) flags.push(`${m.chromeHits} chrome string(s)`);
  const composite = Math.min(1, 0.35 * textBad + 0.30 * chromeBad + 0.20 * blankBad + 0.15 * distortBad);
  return { textCoverage: round(textCoverage), blankRatio: round(blankRatio), aspectDistorted: m.aspectDistorted, chromeHits: m.chromeHits, composite: round(composite), flags };
}

const ctx = await chromium.launchPersistentContext(RAW, {
  headless: false,
  channel: 'chrome',
  locale: 'en-US',
  args: [
    '--profile-directory=Profile 3',
    '--disable-blink-features=AutomationControlled',
    '--disable-sync', '--disable-background-networking', '--no-first-run', '--mute-audio',
  ],
  ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--enable-automation'],
  viewport: { width: 1280, height: 900 },
});

console.log(`\nManual headed pass — ${targets.length} domain(s). You have ~${Math.round(WAIT_MS/1000)}s per site to clear each block.\n`);

for (const d of targets) {
  const art = artPaths(d.name);
  const rec = { domain: d.name, url: d.url, ranAt: new Date().toISOString(), status: 'skip' };
  const page = await ctx.newPage();
  try {
    console.log(`\n▶ ${d.name}  —  ${d.url}\n   → clear the block in the window now…`);
    await page.goto(d.url, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});

    // Poll until the interstitial clears (you interact), or WAIT_MS elapses.
    const deadline = Date.now() + WAIT_MS;
    let blocked = true;
    while (Date.now() < deadline) {
      blocked = await page.evaluate(INTERSTITIAL_SRC).catch(() => true);
      if (!blocked) break;
      await page.waitForTimeout(2_000);
    }
    if (blocked) {
      rec.skipReason = 'still blocked after manual wait';
      writeFileSync(art.score, JSON.stringify(rec, null, 2));
      console.log(`   ✗ still blocked — skipped`);
      continue;
    }
    console.log(`   ✓ block cleared — capturing`);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: art.source, fullPage: false });

    // Capture via the dev test bridge (same message the sweep uses).
    const cap = await page.evaluate(() => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('capture timeout')), 30_000);
      const on = (e) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); window.removeEventListener('message', on);
        if (e.data.error) rej(new Error(e.data.error)); else res(e.data.capture);
      };
      window.addEventListener('message', on);
      window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
    })).catch((e) => ({ __err: e.message }));
    if (cap?.__err) {
      rec.skipReason = `capture failed: ${cap.__err.split('\n')[0]}`;
      writeFileSync(art.score, JSON.stringify(rec, null, 2));
      console.log(`   ✗ ${rec.skipReason}`);
      continue;
    }

    const pageTextLen = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length);

    // Render + shoot + score in /clips.
    const lib = await ctx.newPage();
    try {
      await lib.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
      const post = () => lib.evaluate((capture) => {
        const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
        window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
        window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
      }, cap);
      const row = lib.locator('article.clip').first();
      let vis = false;
      for (let i = 0; i < 4 && !vis; i++) { await post(); try { await row.waitFor({ state: 'visible', timeout: 8_000 }); vis = true; } catch {} }
      if (!vis) { rec.skipReason = 'clip row never rendered'; writeFileSync(art.score, JSON.stringify(rec, null, 2)); console.log('   ✗ clip never rendered'); continue; }
      await row.click();
      const body = lib.locator('.clip-body');
      await body.waitFor({ state: 'visible', timeout: 10_000 });
      await lib.waitForTimeout(1_000);
      await body.evaluate(async (r) => { await Promise.all([...r.querySelectorAll('img')].map(i => (i.complete && i.naturalWidth) ? 0 : i.decode().catch(() => 0))); });
      await lib.waitForTimeout(300);
      await body.screenshot({ path: art.clip });

      // Score the rendered clip with the SAME heuristics the sweep uses.
      const measurements = await lib.evaluate(({ pageTextLen, phrases, fnSrc }) => {
        const el = document.querySelector('.clip-body');
        if (!el) throw new Error('.clip-body missing at score time');
        // eslint-disable-next-line no-new-func
        const fn = new Function('return (' + fnSrc + ')')();
        return fn(el, pageTextLen, phrases);
      }, { pageTextLen, phrases: CHROME_SWEEP_PHRASES, fnSrc: MEASURE_SRC });

      rec.status = 'ok';
      rec.scores = computeScores(measurements);
      rec.note = 'manual headed capture (block cleared with interaction)';
      writeFileSync(art.score, JSON.stringify(rec, null, 2));
      console.log(`   ✓ captured + scored — composite=${rec.scores.composite.toFixed(3)}` +
        (rec.scores.flags.length ? `  [${rec.scores.flags.join(', ')}]` : ''));
    } finally { await lib.close().catch(() => {}); }
  } catch (e) {
    rec.skipReason = `error: ${e.message.split('\n')[0]}`;
    writeFileSync(art.score, JSON.stringify(rec, null, 2));
    console.log(`   ✗ ${rec.skipReason}`);
  } finally {
    await page.close().catch(() => {});
  }
}

await ctx.close();
console.log('\nDone. Reopen sweep-gallery.html (or run node tests/e2e/tools/sweep-gallery.mjs) to see the new captures.\n');
