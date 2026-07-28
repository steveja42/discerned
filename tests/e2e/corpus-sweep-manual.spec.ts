// Manual HEADED capture pass for corpus-sweep domains that hard-block automated
// loads (IP-level walls, 403 stubs, paywall bot-checks the passive headed retry
// can't clear). Opens each named domain in a VISIBLE window and WAITS for you to
// interact — solve the CAPTCHA / click through / dismiss the wall — then runs the
// SAME capture → clip render → score → CAST render path the main sweep uses, via
// the real helpers (not a reimplementation), and writes all THREE images +
// score.json into test-output/corpus-sweep-run/ so they merge into the gallery
// exactly like a normal sweep row.
//
// This is a spec (not the old tools/*.mjs) specifically so it can import the TS
// cast helpers — castShotSafe builds the real kind-30023 cast via the extension's
// BUILD_CAST bridge and renders it through /discerns. The .mjs couldn't do that.
//
// Requires: Chrome fully closed (single-instance lock on Profile 3), pnpm dev
// running (web app :3000), dist-test built. Run:
//   $env:SWEEP_MANUAL='1'; $env:SWEEP_MANUAL_ONLY='reddit-thread,bloomberg'; \
//     pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=corpus-sweep-manual
// Per-site wait: SWEEP_MANUAL_WAIT_MS (default 120000).

import { test, type Page, type Frame } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';
import { screenshotSourcePage, screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';
import { sweepArtifacts, type SweepRecord } from './helpers/sweepArtifacts';
import { computeScores, measureInPage, CHROME_SWEEP_PHRASES, type SweepMeasurements } from './helpers/sweepScorers';
import { refreshSweepGallery } from './helpers/sweepGallery';

/**
 * Auto-solve a PerimeterX 'Press & Hold' captcha so the manual pass clears the
 * gate ITSELF — never depending on (or stealing focus from) the user's clicks.
 * PerimeterX renders the button either in the top document or inside a
 * captcha iframe (`#px-captcha`, `iframe[title*="human"]`, `iframe[src*="px"]`).
 * The gesture is a genuine press-and-HOLD: move to the button centre, mouse.down,
 * hold ~8s (PerimeterX requires a sustained hold, longer than a click), mouse.up.
 * Returns true when it found+pressed a button (caller re-polls to see if it
 * cleared). Best-effort — every failure mode returns false so the loop continues.
 */
async function tryPressAndHold(page: Page): Promise<boolean> {
  // Candidate roots: the page + every frame (the captcha is usually in an iframe).
  const roots: (Page | Frame)[] = [page, ...page.frames()];
  const SELECTORS = [
    '#px-captcha', '#px-captcha [role="button"]',
    '[aria-label*="Press" i]', '[aria-label*="hold" i]',
    'div[role="button"]:has-text("Press")', 'p:has-text("Press & Hold")',
    'text=/press\\s*&?\\s*hold/i',
  ];
  for (const root of roots) {
    for (const sel of SELECTORS) {
      try {
        const loc = root.locator(sel).first();
        if (!(await loc.count())) continue;
        const box = await loc.boundingBox({ timeout: 1_000 }).catch(() => null);
        if (!box || box.width < 4 || box.height < 4) continue;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // Real press-and-HOLD via the page mouse (frame coordinates are relative
        // to the top document viewport for boundingBox, so use page.mouse).
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.waitForTimeout(8_000);
        await page.mouse.up();
        return true;
      } catch { /* try the next selector/root */ }
    }
  }
  return false;
}

interface DomainEntry { name: string; url: string; note?: string }

const DEFAULT_TARGETS = 'reuters,imdb,goodreads-book,nytimes,hackernews';

const DOMAINS: DomainEntry[] = (() => {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'fixtures', 'corpus-domains.json'), 'utf8'),
  ) as { domains: DomainEntry[] };
  const want = new Set((process.env.SWEEP_MANUAL_ONLY || DEFAULT_TARGETS).split(',').map(s => s.trim()).filter(Boolean));
  return raw.domains.filter(d => want.has(d.name));
})();

const WAIT_MS = Number(process.env.SWEEP_MANUAL_WAIT_MS || 120_000);

// Interstitial / block signatures — while ANY of these is on the page, the block
// is still up, so keep waiting (don't capture the wall). Mirrors the sweep's
// detector plus the paywall block-pages the manual pass exists to get past.
const BLOCK_SIGNATURES = [
  'performing security verification', 'checking your browser', 'verify you are human',
  'verifying you are human', 'enable javascript and cookies to continue',
  'needs to review the security', 'attention required', 'ddos protection by', 'just a moment',
  'are you a robot', 'unusual traffic', 'not a bot', 'access is temporarily restricted',
  'we detected unusual activity', 'ray id', '403 forbidden', '403 error', 'access denied',
  'access to this page has been denied', 'request blocked', 'you have been blocked',
  'temporarily unavailable', 'rate limited', 'why did this happen', 'block reference id',
  'been blocked by network security', 'make sure your browser supports javascript and cookies',
  // Strong CAPTCHA phrases (Walmart PerimeterX / Genius / PerimeterX press-hold) —
  // distinctive enough to never appear in real prose, so the manual pass keeps
  // WAITING on them instead of capturing the wall (matches corpus-sweep's STRONG list).
  'robot or human', "make sure you're a human", 'make sure you are a human',
  'we have to make sure you', 'press & hold to confirm', 'press and hold to confirm',
];

// A subset of unambiguous INTERACTIVE-GATE phrases that must keep the pass
// WAITING even when the underlying page already has lots of text. Zillow's
// PerimeterX 'Press & Hold' gate overlays a content-rich listing (>1500 chars of
// underlying DOM), so the generic `t.length > 1500 → not blocked` shortcut fired
// and the pass captured a transitional state MID-gate (the user was still
// pressing). Checked BEFORE the length shortcut so an in-progress gate never
// counts as cleared. These never occur in real listing/article prose.
const STRONG_GATE_SIGNATURES = [
  'press & hold to confirm', 'press and hold to confirm', 'press & hold',
  'robot or human', "make sure you're a human", 'make sure you are a human',
  'we have to make sure you', 'are you a robot', 'verify you are human',
  'verifying you are human', 'performing security verification',
];

test.describe.configure({ mode: 'serial' });

test('corpus-sweep-manual: headed capture for hard-blocked domains', async () => {
  test.skip(!process.env.SWEEP_MANUAL, 'set SWEEP_MANUAL=1 to run the manual headed pass');
  test.setTimeout(DOMAINS.length * (WAIT_MS + 90_000) + 60_000);

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR ??
    resolve(__dirname, '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const profileDirectory = process.env.PROFILE_DIR ?? 'Profile 3';
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory, channel: 'chrome', preinstalledExtension: true,
    headed: true, clearSwCacheForRawDir: true,
  });

  // eslint-disable-next-line no-console
  console.log(`\nManual headed pass — ${DOMAINS.length} domain(s). ~${Math.round(WAIT_MS / 1000)}s per site to clear each block.\n`);

  try {
    for (const d of DOMAINS) {
      const art = sweepArtifacts(d.name);
      const rec: SweepRecord = { domain: d.name, url: d.url, ranAt: new Date().toISOString(), status: 'skip' };
      const url = process.env[`SWEEP_URL_${d.name.toUpperCase()}`] || d.url;
      const page = await ctx.newPage();
      try {
        // eslint-disable-next-line no-console
        console.log(`\n▶ ${d.name}  —  ${url}\n   → clear the block in the window now…`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});

        // Poll until the page has been block-free for a SUSTAINED window, or
        // WAIT_MS. A single "looks clear" poll is NOT enough: some walls
        // (Zillow's PerimeterX) render the LISTING FIRST and THEN pop the
        // 'Press & Hold' gate a second or two later — so an instant capture on
        // first-clear grabs a transitional state while the user is still mid-gate.
        // Require STABLE_CLEARS consecutive gate-free polls (a settle window)
        // before proceeding, and check STRONG interactive-gate phrases BEFORE the
        // "long page = clear" shortcut so an overlaid gate on a content-rich page
        // still counts as blocked.
        const deadline = Date.now() + WAIT_MS;
        const STABLE_CLEARS = 3; // ×2s = 6s of continuous gate-free state
        let clearStreak = 0;
        while (Date.now() < deadline) {
          const blocked = await page.evaluate(
            ({ sigs, strong }: { sigs: string[]; strong: string[] }) => {
              let t = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
              for (const f of Array.from(document.querySelectorAll('iframe'))) {
                try {
                  const i = (f as HTMLIFrameElement).contentDocument?.body?.innerText ?? '';
                  if (i) t = (t + ' ' + i).trim();
                } catch { /* cross-origin */ }
              }
              const low = t.toLowerCase();
              if (t.length < 20) return true;
              // STRONG interactive-gate phrases block REGARDLESS of page length —
              // Zillow's gate overlays a >1500-char listing.
              if (strong.some(s => low.includes(s))) return true;
              if (t.length > 1500) return false;
              return sigs.some(s => low.includes(s));
            },
            { sigs: BLOCK_SIGNATURES, strong: STRONG_GATE_SIGNATURES },
          ).catch(() => true);
          // Auto-solve a PerimeterX 'Press & Hold' gate ourselves (so the run
          // never depends on — or steals focus from — the user). Detect the
          // captcha button (top-document or inside a px iframe) and press-and-HOLD
          // it: mouse.down → hold ~8s → mouse.up, which is what the human gesture
          // does. Runs only while `blocked`; on success the next poll sees it clear.
          if (blocked && !process.env.SWEEP_MANUAL_NO_AUTOSOLVE) {
            const solved = await tryPressAndHold(page).catch(() => false);
            if (solved) { await page.waitForTimeout(1_500); continue; }
          }
          clearStreak = blocked ? 0 : clearStreak + 1;
          if (clearStreak >= STABLE_CLEARS) break;
          await page.waitForTimeout(2_000);
        }
        const blocked = clearStreak < STABLE_CLEARS;
        if (blocked) {
          rec.skipReason = 'still blocked after manual wait';
          writeFileSync(art.score(), JSON.stringify(rec, null, 2));
          // eslint-disable-next-line no-console
          console.log('   ✗ still blocked — skipped');
          continue;
        }
        // eslint-disable-next-line no-console
        console.log('   ✓ block cleared — capturing');
        await page.waitForTimeout(1_500);
        // Wait for a populated article body — AP News / Reuters inject the story
        // paragraphs lazily after first paint, so capturing too early yields a
        // hero-only shell (near-empty once the comment widget is excluded).
        await page.evaluate(async () => {
          const SELS = ['[class*="RichTextStoryBody"]', '[data-testid="ArticleBody"]',
            '[class*="article-body"]', '[data-testid^="paragraph"]', 'article'];
          const len = () => {
            for (const s of SELS) { const el = document.querySelector(s);
              if (el) { const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim(); if (t.length > 600) return t.length; } }
            return 0;
          };
          const deadline = Date.now() + 8000;
          // eslint-disable-next-line no-unmodified-loop-condition
          while (Date.now() < deadline && len() < 600) { await new Promise(r => setTimeout(r, 400)); }
        }).catch(() => undefined);
        await screenshotSourcePage(page, art.source());

        // Capture via the dev test bridge.
        let cap: Record<string, unknown>;
        try {
          cap = (await page.evaluate(
            () => new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('capture timeout')), 30_000);
              const on = (e: MessageEvent) => {
                if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
                clearTimeout(t); window.removeEventListener('message', on);
                if (e.data.error) rej(new Error(e.data.error)); else res(e.data.capture);
              };
              window.addEventListener('message', on);
              window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
            }),
          )) as Record<string, unknown>;
        } catch (capErr) {
          rec.skipReason = `capture failed: ${(capErr as Error).message.split('\n')[0]}`;
          writeFileSync(art.score(), JSON.stringify(rec, null, 2));
          // eslint-disable-next-line no-console
          console.log(`   ✗ ${rec.skipReason}`);
          continue;
        }

        const pageTextLen = await page.evaluate(
          () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
        );

        // Render clip + score.
        const libPage = await ctx.newPage();
        try {
          await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
          const postClip = () => libPage.evaluate((capture) => {
            const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
            window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
            window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
          }, cap);
          const row = libPage.locator('article.clip').first();
          let vis = false;
          for (let i = 0; i < 4 && !vis; i++) {
            await postClip();
            try { await row.waitFor({ state: 'visible', timeout: 8_000 }); vis = true; } catch { /* re-post */ }
          }
          if (!vis) {
            rec.skipReason = 'clip row never rendered';
            writeFileSync(art.score(), JSON.stringify(rec, null, 2));
            // eslint-disable-next-line no-console
            console.log('   ✗ clip never rendered');
            continue;
          }
          await row.click();
          const clipBody = libPage.locator('.clip-body');
          await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
          await libPage.waitForTimeout(1_000);
          await clipBody.evaluate(async (r) => {
            await Promise.all(Array.from(r.querySelectorAll('img')).map(i =>
              (i.complete && i.naturalWidth > 0) ? Promise.resolve() : i.decode().catch(() => undefined)));
          });
          await libPage.waitForTimeout(300);
          await screenshotClipBody(libPage, clipBody, art.clip());

          const measurements = (await libPage.evaluate(
            (args: { pageTextLen: number; phrases: string[]; fnStr: string }) => {
              const body = document.querySelector('.clip-body');
              if (!body) throw new Error('.clip-body missing at score time');
              // eslint-disable-next-line no-new-func
              const fn = new Function('return (' + args.fnStr + ')')() as typeof measureInPage;
              return fn(body, args.pageTextLen, args.phrases);
            },
            { pageTextLen, phrases: CHROME_SWEEP_PHRASES, fnStr: measureInPage.toString() },
          )) as SweepMeasurements;

          rec.status = 'ok';
          rec.scores = computeScores(measurements);
          rec.note = 'manual headed capture (block cleared with interaction)';
          writeFileSync(art.score(), JSON.stringify(rec, null, 2));
          // eslint-disable-next-line no-console
          console.log(`   ✓ captured + scored — composite=${rec.scores.composite.toFixed(3)}` +
            (rec.scores.flags.length ? `  [${rec.scores.flags.join(', ')}]` : ''));
        } finally {
          await libPage.close().catch(() => undefined);
        }

        // CAST (the whole reason this is a spec): build + render the real cast.
        const castText = await castShotSafe(page, cap as { title?: string }, art.cast());
        // eslint-disable-next-line no-console
        console.log(castText ? '   ✓ cast rendered' : '   – no castable body (cast skipped)');
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await ctx.close();
  }

  refreshSweepGallery();
});
