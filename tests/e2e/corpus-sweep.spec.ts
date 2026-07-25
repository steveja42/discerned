// Phase 4.1 — broad-web corpus sweep.
//
// Runs article capture against ~50 popular domains we have NOT hand-curated
// (tests/fixtures/corpus-domains.json — real ARTICLE deep-links, discovered live
// via tools/discover-article-urls.mjs, NOT homepages: a homepage's lead-story
// teaser is a hero + no body, which the scorer mistakes for a broken clip),
// scores each clip with content-free quality heuristics (helpers/sweepScorers.ts),
// writes the three hero images (source / clip / cast) + a score.json per domain
// into its OWN folder (test-output/corpus-sweep-run/), and builds a worst-first /
// by-date sortable review gallery. You eyeball only the worst decile; a page that
// won't load is a SKIP, not a scored finding (same load-vs-capture split as the
// tagger canary).
//
// This is a DISCOVERY tool, not a CI gate: the heuristics triage which of many
// unseen sites are likely broken so a human can classify the failures as
// PATTERNS and fix them generically (per the capture-quality philosophy). The
// pixel-baseline fixture specs remain the real regression floor.
//
// Run against the warm 'test' profile (Cloudflare-cleared, extension
// preinstalled — the only setup that gets walled sites to load):
//   $env:SWEEP='1'; pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=corpus-sweep
// Options: SWEEP_LIMIT=10 (first N domains), SWEEP_ONLY=theverge,cnn (subset),
//   PROFILE_DIR=Profile 3 (default), SWEEP_NO_HEADED_RETRY=1 (skip the headed pass).
//
// Headed retry for Cloudflare: the main pass runs HEADLESS (out of your way). A
// few sites (politico, axios) sit behind Cloudflare Turnstile that clears only
// with a REAL visible window — even a deep article URL is walled. So after the
// headless pass, any domain that skipped with a "challenge/error page" reason is
// retried in a SECOND, HEADED pass. The profile's cf_clearance + a visible window
// is enough to clear them with NO manual clicking (verified via the discovery
// tool). Set SWEEP_NO_HEADED_RETRY=1 to keep the whole run headless (those sites
// then stay skipped). The headed window is brief and only opens for the handful
// of still-walled domains, not the whole corpus.

import { test, type BrowserContext } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';
import { screenshotSourcePage, screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';
import { sweepArtifacts, type SweepRecord } from './helpers/sweepArtifacts';
import { computeScores, measureInPage, CHROME_SWEEP_PHRASES, type SweepMeasurements } from './helpers/sweepScorers';
import { refreshSweepGallery } from './helpers/sweepGallery';

interface DomainEntry { name: string; url: string; note?: string }

const DOMAINS: DomainEntry[] = (() => {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'fixtures', 'corpus-domains.json'), 'utf8'),
  ) as { domains: DomainEntry[] };
  let list = raw.domains;
  if (process.env.SWEEP_ONLY) {
    const only = new Set(process.env.SWEEP_ONLY.split(',').map(s => s.trim()));
    list = list.filter(d => only.has(d.name));
  }
  if (process.env.SWEEP_LIMIT) list = list.slice(0, Number(process.env.SWEEP_LIMIT));
  return list;
})();

test.describe.configure({ mode: 'serial' });

// A record the driver marks with `challenged` when the skip was a Cloudflare /
// bot wall (so the headed-retry pass knows which to re-attempt). `challenged` is
// stripped before the record is persisted to score.json (it's driver bookkeeping).
type SweepDriverRecord = SweepRecord & { challenged?: boolean };

// Persist a record to its score.json, dropping driver-only bookkeeping.
function persist(rec: SweepDriverRecord): void {
  const { challenged: _challenged, ...clean } = rec;
  writeFileSync(sweepArtifacts(rec.domain).score(), JSON.stringify(clean, null, 2));
}

/**
 * Capture + render + score ONE domain in the given context. Returns a fully
 * populated SweepRecord (never throws — every failure mode becomes a status:'skip'
 * record). Writes the source/clip/cast images + score.json as it goes. The whole
 * body is failure-isolated so one bad domain can never abort the sweep (the sweep
 * is a single serial test; an un-caught throw would kill every later domain).
 */
async function captureDomain(ctx: BrowserContext, d: DomainEntry): Promise<SweepDriverRecord> {
  const art = sweepArtifacts(d.name);
  const rec: SweepDriverRecord = { domain: d.name, url: d.url, ranAt: new Date().toISOString(), status: 'skip' };
  const url = process.env[`SWEEP_URL_${d.name.toUpperCase()}`] || d.url;
  const page = await ctx.newPage();
  try {
    // ── Load (load-vs-capture skip) ───────────────────────────────────────
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForTimeout(3_500); // let SPA content paint
      // Best-effort wait for a populated article body — some news sites (AP News,
      // Reuters) inject the story paragraphs lazily AFTER first paint, so a fixed
      // 3.5s wait can capture a hero-only shell (once the comment widget is
      // excluded there's nothing else, so the clip comes out near-empty). Poll a
      // few common article-body containers for real prose, capped at ~6s extra.
      await page.evaluate(async () => {
        const SELS = [
          '[class*="RichTextStoryBody"]', '[data-testid="ArticleBody"]',
          '[class*="article-body"]', '[data-testid^="paragraph"]', 'article',
        ];
        const bodyTextLen = () => {
          for (const s of SELS) {
            const el = document.querySelector(s);
            if (el) { const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim(); if (t.length > 600) return t.length; }
          }
          return 0;
        };
        const deadline = Date.now() + 6000;
        // eslint-disable-next-line no-unmodified-loop-condition
        while (Date.now() < deadline && bodyTextLen() < 600) {
          await new Promise(r => setTimeout(r, 400));
        }
      }).catch(() => undefined);
      await screenshotSourcePage(page, art.source());
    } catch (navErr) {
      rec.skipReason = `load failed: ${(navErr as Error).message.split('\n')[0]}`;
      persist(rec);
      return rec;
    }

    // ── Challenge / error interstitial → SKIP, not a scored clip ──────────
    // A page that returned a Cloudflare "security verification" wall, a bot
    // check, or a 403/access-denied stub navigated FINE (so goto didn't throw)
    // but has no article to capture. Left un-skipped it captures the
    // interstitial and pollutes the scored set + worst decile. Detect the
    // signature text on a SHORT page and demote to a load-vs-capture SKIP —
    // same contract as the tagger canary's "page won't load" case. A CF wall is
    // flagged `challenged` so the driver retries it HEADED.
    const interstitial = await page.evaluate(() => {
      // Gather text from the main document AND any same-origin iframes — some
      // walls (Reuters' "Access is temporarily restricted") render the block
      // inside an iframe, so document.body.innerText is EMPTY and a signature
      // match on the top document alone misses it.
      let t = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const inner = (f as HTMLIFrameElement).contentDocument?.body?.innerText ?? '';
          if (inner) t = (t + ' ' + inner).trim();
        } catch { /* cross-origin frame — unreadable, skip */ }
      }
      // A page with essentially NO body text (block in a cross-origin iframe, or
      // an empty stub) has nothing to capture regardless of the reason.
      if (t.length < 20) return { hit: 'empty body (likely iframe wall / stub)', len: t.length, cf: false };
      // Only treat longer pages as an interstitial when SHORT enough that a real
      // article's prose couldn't be there — a real article merely containing
      // "access denied" in its body stays.
      if (t.length > 1500) return null;
      const low = t.toLowerCase();
      // CF/bot-CHALLENGE signatures — these can clear when retried HEADED.
      const CHALLENGE = [
        'performing security verification', 'checking your browser',
        'verify you are human', 'verifying you are human',
        'enable javascript and cookies to continue', 'needs to review the security',
        'attention required', 'ddos protection by', 'just a moment',
        'are you a robot', 'unusual traffic', 'not a bot',
        'access is temporarily restricted', 'we detected unusual activity',
      ];
      // HARD-block signatures — a headed retry won't help (IP/account level).
      const HARD = [
        'ray id', '403 forbidden', '403 error', 'access denied',
        'access to this page has been denied', 'request blocked',
        'you have been blocked', 'temporarily unavailable', 'rate limited',
      ];
      const cfHit = CHALLENGE.find(s => low.includes(s));
      if (cfHit) return { hit: cfHit, len: t.length, cf: true };
      const hardHit = HARD.find(s => low.includes(s));
      return hardHit ? { hit: hardHit, len: t.length, cf: false } : null;
    });
    if (interstitial) {
      rec.skipReason = `challenge/error page ("${interstitial.hit}", ${interstitial.len} chars)`;
      rec.challenged = interstitial.cf; // driver retries CF challenges headed
      persist(rec);
      return rec;
    }

    // ── Capture via the dev test bridge ───────────────────────────────────
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
      persist(rec);
      return rec;
    }

    const pageTextLen = await page.evaluate(
      () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
    );

    // ── Render + score + cast ─────────────────────────────────────────────
    const libPage = await ctx.newPage();
    try {
      await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
      const postClip = () => libPage.evaluate((capture) => {
        const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
        window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
        window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
      }, cap);

      const row = libPage.locator('article.clip').first();
      let rowVisible = false;
      for (let attempt = 0; attempt < 4 && !rowVisible; attempt++) {
        await postClip();
        try { await row.waitFor({ state: 'visible', timeout: 8_000 }); rowVisible = true; }
        catch { /* bridge race — re-post */ }
      }
      if (!rowVisible) {
        rec.skipReason = 'clip row never rendered in /clips';
        persist(rec);
        return rec;
      }
      await row.click();
      const clipBody = libPage.locator('.clip-body');
      await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
      await libPage.waitForTimeout(1_000);

      // Decode all imgs so aspect measurement + screenshot are stable.
      await clipBody.evaluate(async (root) => {
        await Promise.all(Array.from(root.querySelectorAll('img')).map(img =>
          (img.complete && img.naturalWidth > 0) ? Promise.resolve() : img.decode().catch(() => undefined)));
      });
      await libPage.waitForTimeout(300);

      await screenshotClipBody(libPage, clipBody, art.clip());

      // ── Score ───────────────────────────────────────────────────────────
      // Run measureInPage against the rendered clip body. Injected as a string
      // (its .toString()) + rebuilt in-page so the helper doesn't need bundling.
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
      delete rec.skipReason;
      delete rec.challenged;
      persist(rec);

      // ── Cast (additive third image — never fails the sweep) ─────────────
      await castShotSafe(page, cap as { title?: string }, art.cast());
      return rec;
    } catch (renderErr) {
      rec.status = 'skip';
      rec.scores = undefined;
      rec.skipReason = `render/score failed: ${(renderErr as Error).message.split('\n')[0]}`;
      persist(rec);
      return rec;
    } finally {
      await libPage.close().catch(() => undefined);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

// Merge one pass's records into the accumulator (by domain), preferring an 'ok'
// over a prior 'skip' (the headed retry can only improve a domain's outcome).
function mergeRecord(acc: Map<string, SweepDriverRecord>, rec: SweepDriverRecord): void {
  const prev = acc.get(rec.domain);
  if (!prev || (prev.status !== 'ok' && rec.status === 'ok')) acc.set(rec.domain, rec);
}

test('corpus-sweep: capture + score ~50 domains, build ranked gallery', async () => {
  test.skip(!process.env.SWEEP, 'set SWEEP=1 to run the broad-web corpus sweep');
  // ~75s budget per domain (nav + capture + render + 3 screenshots + cast), plus
  // headroom for the headed-retry pass over the CF-challenged subset.
  test.setTimeout(DOMAINS.length * 75_000 + 120_000);

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR ??
    resolve(__dirname, '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const profileDirectory = process.env.PROFILE_DIR ?? 'Profile 3';
  const channel = (process.env.BROWSER_CHANNEL as 'chrome') ?? 'chrome';

  const acc = new Map<string, SweepDriverRecord>();

  // ── Pass 1: HEADLESS (out of the user's way) ────────────────────────────
  // The warm branded-Chrome profile (Profile 3) with the extension HAND-INSTALLED
  // + a valid cf_clearance — the only setup that runs the extension AND clears
  // Cloudflare on the sites that clear at all (see project_real_chrome_extension_cdp_load).
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory, channel, preinstalledExtension: true, headed: false,
    // Force the SW to re-register from current dist-test so background changes
    // (createLongFormEvent cast logic, BUILD_CAST) aren't served stale from the
    // cached MV3 worker. Clears SW/code cache only — cf_clearance + logins survive.
    clearSwCacheForRawDir: true,
  });
  try {
    for (const d of DOMAINS) {
      const rec = await captureDomain(ctx, d);
      mergeRecord(acc, rec);
      // eslint-disable-next-line no-console
      console.log(rec.status === 'ok'
        ? `OK    ${d.name.padEnd(20)} composite=${rec.scores!.composite.toFixed(3)}` +
            (rec.scores!.flags.length ? `  [${rec.scores!.flags.join(', ')}]` : '')
        : `SKIP  ${d.name.padEnd(20)} ${rec.skipReason}`);
    }
  } finally {
    await ctx.close();
  }

  // ── Pass 2: HEADED retry for Cloudflare-challenged domains only ─────────
  // A visible window + the profile's cf_clearance clears Turnstile with no manual
  // clicking. Only the handful of still-walled domains open a window, briefly.
  const cfDomains = DOMAINS.filter(d => acc.get(d.name)?.challenged);
  if (cfDomains.length && !process.env.SWEEP_NO_HEADED_RETRY) {
    // eslint-disable-next-line no-console
    console.log(`\n── headed retry for ${cfDomains.length} CF-challenged domain(s): ${cfDomains.map(d => d.name).join(', ')} ──`);
    const { ctx: headedCtx } = await launchWithExtension({
      rawUserDataDir, profileDirectory, channel, preinstalledExtension: true, headed: true,
      clearSwCacheForRawDir: true,
    });
    try {
      for (const d of cfDomains) {
        const rec = await captureDomain(headedCtx, d);
        mergeRecord(acc, rec);
        // eslint-disable-next-line no-console
        console.log(rec.status === 'ok'
          ? `OK*   ${d.name.padEnd(20)} composite=${rec.scores!.composite.toFixed(3)} (headed)` +
              (rec.scores!.flags.length ? `  [${rec.scores!.flags.join(', ')}]` : '')
          : `SKIP* ${d.name.padEnd(20)} ${rec.skipReason} (headed)`);
      }
    } finally {
      await headedCtx.close();
    }
  }

  // ── Ranked summary + gallery ────────────────────────────────────────────
  const records = [...acc.values()];
  const scored = records.filter(r => r.status === 'ok');
  const skipped = records.filter(r => r.status === 'skip');
  scored.sort((a, b) => (b.scores!.composite) - (a.scores!.composite));
  const worst = scored.slice(0, Math.max(1, Math.ceil(scored.length / 10)));
  const summary = [
    `Corpus sweep — ${new Date().toISOString()}`,
    `${records.length} domains · ${scored.length} scored · ${skipped.length} skipped`,
    '',
    'Worst decile (eyeball these):',
    ...worst.map(r => `  ${r.scores!.composite.toFixed(3)}  ${r.domain.padEnd(20)} [${r.scores!.flags.join(', ')}]`),
  ].join('\n');
  writeFileSync(resolve(art_dir(), 'sweep-summary.txt'), summary + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log('\n' + summary + '\n');
  refreshSweepGallery();
});

// The run dir (all domains share it); use one domain's helper to resolve it.
function art_dir(): string {
  return sweepArtifacts('_').dir;
}
