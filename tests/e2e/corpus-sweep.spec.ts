// Phase 4.1 — broad-web corpus sweep.
//
// Runs article capture against the popular domains we have NOT hand-curated
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
//   SWEEP_SKIP=imdb,nytimes (exclude a subset), PROFILE_DIR=Profile 3 (default),
//   SWEEP_NO_HEADED_RETRY=1 (skip the CF headed pass), SWEEP_NO_PX_FIRST=1
//   (skip the PerimeterX headed-first pass — NOT recommended, see below),
//   SWEEP_GAP=<seconds> (pause between domains, default 20 — see GAP_SECS;
//   0 disables it for offline/localhost corpora or a single domain).
//
// THREE-PASS flow:
//  • Pass 0 — HEADED-FIRST: PerimeterX sites (PERIMETERX_SITES), logged-in social
//    feeds (SOCIAL_FEED_SITES), and every domain marked `"headed": true` in
//    corpus-domains.json (HEADED_ONLY_SITES — add new ones THERE, not here).
//    These are run headed BEFORE any headless
//    hit and are EXCLUDED from Pass 1. PerimeterX scores the fingerprint+session:
//    a headless hit is the most suspicious signal and RAISES the risk score,
//    escalating the wall to a hard block that persists for a cooldown — locking
//    the site out even for a later headed attempt AND the user's own clicks. So we
//    never touch them headless. The pass auto-solves the 'Press & Hold' gate
//    (tryPressAndHold) + waits for a sustained gate-free state, so it needs NO
//    user clicks. This is the DEFAULT (disable with SWEEP_NO_PX_FIRST=1).
//  • Pass 1 — HEADLESS for everyone else (out of your way).
//  • Pass 2 — CLOUDFLARE headed retry: a few sites (politico, axios, medium) sit
//    behind CF Turnstile that clears only in a REAL window. Any domain that
//    skipped headless with a "challenge/error page" is retried headed; the
//    profile's cf_clearance clears them with NO clicking. CF (unlike PerimeterX)
//    is repeatable, so it's safe to hit these headless first. PerimeterX sites are
//    excluded here (they had their shot in Pass 0). SWEEP_NO_HEADED_RETRY=1 skips it.

import { test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';
import { screenshotSourcePage, screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';
import { sweepArtifacts, type SweepRecord } from './helpers/sweepArtifacts';
import { computeScores, measureInPage, CHROME_SWEEP_PHRASES, type SweepMeasurements } from './helpers/sweepScorers';
import { refreshSweepGallery } from './helpers/sweepGallery';

interface DomainEntry { name: string; url: string; note?: string; headed?: boolean }

// Read once, BEFORE the headed-routing sets below (which derive from it) and
// before DOMAINS, which applies SWEEP_ONLY/SWEEP_LIMIT filtering to this list.
const DOMAINS_RAW: DomainEntry[] = (JSON.parse(
  readFileSync(resolve(__dirname, '..', 'fixtures', 'corpus-domains.json'), 'utf8'),
) as { domains: DomainEntry[] }).domains;

// Domains behind a PerimeterX (HUMAN) wall — "Robot or human?" / "Press & Hold".
// These are run HEADED-FIRST (Pass 0), BEFORE any headless hit, and are EXCLUDED
// from the headless Pass 1. Rationale: PerimeterX scores the fingerprint+session,
// not the URL. A headless-Chrome hit is the most suspicious signal and RAISES the
// risk score, which escalates the wall from "solvable Press & Hold" to a hard
// block that persists for a cooldown — locking the site out even for a subsequent
// headed attempt (and the user's own clicks). So we never touch them headless.
// (Cloudflare sites don't have this problem — cf_clearance makes the headed retry
// repeatable — so THOSE stay in the normal headless→headed-retry flow.)
const PERIMETERX_SITES = new Set([
  'walmart', 'zillow', 'etsy', 'yelp', 'homedepot', 'goodreads-book', 'goodreads-author',
]);

// Phase 4.4 — logged-in SOCIAL FEEDS (Instagram / Facebook / TikTok). These need
// a real session in the warm profile, and they serve a login wall (or an empty
// shell) to a headless hit even when cookies are present, so they run HEADED in
// Pass 0 alongside the PerimeterX set rather than being scored as skips.
// A logged-OUT profile still yields an honest skip (the interstitial detector
// catches the login page), so the sweep degrades gracefully.
const SOCIAL_FEED_SITES = new Set([
  'instagram-reels', 'instagram-home', 'facebook-home', 'facebook-reels',
  // TikTok needs no login, but a HEADLESS hit gets "Something went wrong" — so
  // it belongs in the headed pass for the bot-detection reason, not a session one.
  'tiktok-foryou', 'tiktok-profile',
]);

// Domains that must never take a headless hit, declared as `"headed": true` in
// corpus-domains.json (see its _comment). Kept as DATA next to the URL rather
// than as another hardcoded set here: the two sets above are behavioural (they
// also change how Pass 0 and Pass 2 treat a domain), whereas this is pure
// routing, and a list in the spec silently drifts as domains are added.
//
// Why it matters: a headless hit on one of these returns a hard interstitial,
// which is classified HARD → `challenged = false` → EXCLUDED from the Pass-2
// headed retry, leaving the domain unreachable for the whole run at any pacing.
// On a stateful site it is worse still — Medium blocks on a second load in quick
// succession and stays blocked for that profile until cleared by hand, so the
// wasted headless load locks out the headed pass that would have worked.
const HEADED_ONLY_SITES = new Set(
  DOMAINS_RAW.filter(d => d.headed).map(d => d.name),
);

const DOMAINS: DomainEntry[] = (() => {
  let list = DOMAINS_RAW;
  if (process.env.SWEEP_ONLY) {
    const only = new Set(process.env.SWEEP_ONLY.split(',').map(s => s.trim()));
    list = list.filter(d => only.has(d.name));
  }
  if (process.env.SWEEP_SKIP) {
    const skip = new Set(process.env.SWEEP_SKIP.split(',').map(s => s.trim()));
    list = list.filter(d => !skip.has(d.name));
  }
  if (process.env.SWEEP_LIMIT) list = list.slice(0, Number(process.env.SWEEP_LIMIT));
  return list;
})();

/**
 * Auto-solve a PerimeterX 'Press & Hold' captcha in a HEADED context so the sweep
 * clears the gate itself (no user clicks, no focus-stealing). Locates the captcha
 * button across the page + its frames and press-and-HOLDS it (~8s — PerimeterX
 * needs a sustained hold). Best-effort; every failure mode returns false. Mirrors
 * corpus-sweep-manual's tryPressAndHold.
 */
async function tryPressAndHold(page: Page): Promise<boolean> {
  const roots = [page, ...page.frames()];
  const SELECTORS = ['#px-captcha', '#px-captcha [role="button"]', '[aria-label*="Press" i]',
    '[aria-label*="hold" i]', 'text=/press\\s*&?\\s*hold/i'];
  for (const root of roots) {
    for (const sel of SELECTORS) {
      try {
        const loc = root.locator(sel).first();
        if (!(await loc.count())) continue;
        const box = await loc.boundingBox({ timeout: 1_000 }).catch(() => null);
        if (!box || box.width < 4 || box.height < 4) continue;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(8_000);
        await page.mouse.up();
        return true;
      } catch { /* next */ }
    }
  }
  return false;
}

/**
 * Delete every clip already in the extension's IndexedDB.
 *
 * The sweep posts each capture into /clips itself, but the REAL extension's
 * web-bridge additionally pushes everything it has stored from previous runs.
 * Those leftovers crowd the library: the row for the clip we just posted may not
 * be `.first()`, and a detail panel can sit on a stale clip — which silently
 * screenshot+scored the WRONG SITE (8 domains once shared one Amazon clip image,
 * scored as "healthy"). Purging once per context makes each run deterministic.
 * Best-effort: a failure here must never abort the sweep.
 */
async function purgeStoredClips(ctx: BrowserContext): Promise<number> {
  const page = await ctx.newPage();
  try {
    await page.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    // Give the extension bridge a moment to push its stored clips in.
    await page.waitForTimeout(3_000);
    // Ask the bridge for the stored clips, then delete them by id. Both messages
    // are the web app's own protocol (web-bridge.ts forwards GET_CLIPS /
    // DELETE_CLIPS to the background worker, which owns IndexedDB).
    const ids = await page.evaluate(() => new Promise<string[]>((res) => {
      const timer = setTimeout(() => { window.removeEventListener('message', on); res([]); }, 8_000);
      function on(e: MessageEvent) {
        if (e.data?.type !== 'DISCERNED_BRIDGE_CLIPS') return;
        clearTimeout(timer);
        window.removeEventListener('message', on);
        const clips = (e.data.clips ?? []) as Array<{ capture?: { id?: string } }>;
        res(clips.map(c => c.capture?.id).filter((x): x is string => !!x));
      }
      window.addEventListener('message', on);
      // DISCERNED_WEB_READY makes the bridge (re-)push its stored clip list.
      window.postMessage({ type: 'DISCERNED_WEB_READY' }, window.location.origin);
    }));
    if (ids.length === 0) return 0;
    await page.evaluate((toDelete: string[]) => {
      window.postMessage({ type: 'DISCERNED_DELETE_CLIPS', ids: toDelete }, window.location.origin);
    }, ids);
    await page.waitForTimeout(2_000);
    return ids.length;
  } catch {
    return 0;
  } finally {
    await page.close().catch(() => undefined);
  }
}

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
async function captureDomain(ctx: BrowserContext, d: DomainEntry, ctxIsHeaded = false): Promise<SweepDriverRecord> {
  const art = sweepArtifacts(d.name);
  const rec: SweepDriverRecord = { domain: d.name, url: d.url, ranAt: new Date().toISOString(), status: 'skip' };
  const url = process.env[`SWEEP_URL_${d.name.toUpperCase()}`] || d.url;
  const page = await ctx.newPage();
  try {
    // ── Load (load-vs-capture skip) ───────────────────────────────────────
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForTimeout(3_500); // let SPA content paint
      // PerimeterX 'Press & Hold' gate handling — HEADED only (a headless attempt
      // can't clear it and only escalates the risk score). The AUTO-SOLVER tries
      // first (press-and-hold ~8s per attempt) for a short window; if it still
      // can't clear, we PRINT A PROMPT and wait for the USER to clear it. Either
      // way we require a STABLE gate-free state (3 consecutive clear polls) before
      // capturing — some walls (Zillow) render the listing THEN pop the gate ~2s
      // later, so an instant capture would grab a transitional mid-gate state.
      if (ctxIsHeaded) {
        // NOTE the `(?:&(?:amp;)?|and)?` separator: Zillow's wall says "press AND
        // hold", which the old `&?` form did NOT match — so gateUp() reported "no
        // gate", the loop exited after 3 clear polls (~6s), the manual prompt never
        // printed, and the sweep advanced WHILE THE USER WAS STILL PRESS-AND-HOLDING.
        // The interstitial detector below already lists 'press and hold to confirm',
        // so the two checks disagreed on the same page. `&amp;` covers entity text.
        // Covers BOTH wall families. It previously held only the PerimeterX
        // press-and-hold phrasings, so on a CLOUDFLARE site gateUp() returned
        // false immediately, the loop exited after 3 clear polls (~6s), and the
        // window closed WHILE THE USER WAS CLICKING THE GATE (observed on
        // librarything, whose wall reads "Verifying you are human" — note the
        // -ING, which `verify you are human` does not match). Measured: 7 of 8
        // real wall texts missed. Keep this in sync with the CHALLENGE list in
        // the interstitial detector below — the two must agree on what a wall is.
        const GATE_RE = new RegExp([
          // PerimeterX
          'press\\s*(?:&(?:amp;)?|and)?\\s*hold', 'robot or human',
          "make sure you'?re a human", 'are you a robot',
          // Cloudflare / generic bot checks
          // "verif(y|ying) you are" — NOT the looser "verify your", which hits
          // ordinary prose ("he would verify your identity at the polls").
          'verif(?:y|ying)\\s+(?:that\\s+)?you\\s+are',
          'checking your browser', 'checking your connection',
          'security verification', 'needs to review the security',
          // Anchored: bare "just a moment" appears mid-sentence in real prose
          // ("after just a moment of hesitation"); CF renders it as the whole
          // page/title, so require it at the start of the text.
          '^\\s*just a moment',
          'enable javascript and cookies', 'additional verification required',
        ].join('|'), 'i');
        const gateUp = async () => page.evaluate((reStr: string) => {
          const re = new RegExp(reStr, 'i');
          const t = (document.body?.innerText ?? '').trim();
          return t.length < 40 || re.test(t);
        }, GATE_RE.source).catch(() => false);
        const AUTO_ATTEMPTS = 3;          // ~3 press-and-hold tries (~30s) before asking the user
        const TOTAL_POLLS = 90;           // then up to ~3min more for a manual clear
        let streak = 0, attempt = 0, prompted = false;
        for (let i = 0; i < TOTAL_POLLS && streak < 3; i++) {
          if (await gateUp()) {
            streak = 0;
            if (attempt < AUTO_ATTEMPTS) { await tryPressAndHold(page).catch(() => false); attempt++; }
            else if (!prompted) {
              prompted = true;
              // eslint-disable-next-line no-console
              console.log(`   ⚠ ${d.name}: auto press-and-hold didn't clear the gate — please clear it in the window now…`);
            }
          } else streak++;
          await page.waitForTimeout(2_000);
        }
      }
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
      const msg = (navErr as Error).message.split('\n')[0];
      rec.skipReason = `load failed: ${msg}`;
      // Some sites refuse the HEADLESS connection outright rather than serving a
      // challenge page — CBC answers ERR_HTTP2_PROTOCOL_ERROR headless but loads
      // normally in a real window. A transport-level refusal is worth the headed
      // retry for the same reason a challenge page is; a genuine 404/DNS failure
      // won't clear and just skips again.
      if (/ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_(RESET|CLOSED)|ERR_SSL/.test(msg)) {
        rec.challenged = true;
      }
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
    const interstitial = await page.evaluate((requestedUrl: string) => {
      // ── DEAD PAGE / HOMEPAGE REDIRECT (scored `ok` before this check) ──────
      // A 404 or a deep link silently bounced to the site root still RENDERS, so
      // nothing above catches it: the sweep captured GitHub's 404 page
      // ("This is not the web page you are looking for"), VentureBeat's "Not
      // Found", and Home Depot's HOMEPAGE (product URL 403s → root) and scored
      // all three as healthy clips. A block page that scores WELL is worse than
      // an honest skip — same false-pass class as the phys.org / YouTube-Music
      // stubs already handled below. These are NOT cf-retryable (a headed retry
      // gets the same dead URL), so cf:false — fix the corpus entry instead.
      const title = (document.title ?? '').toLowerCase();
      const DEAD_TITLE = ['404', 'not found', 'page not found', 'page missing',
        'no longer available', 'nothing here'];
      const deadTitleHit = DEAD_TITLE.find(s => title.includes(s));
      if (deadTitleHit) return { hit: `dead page (title: "${document.title}")`, len: title.length, cf: false };
      try {
        const want = new URL(requestedUrl);
        const got = new URL(window.location.href);
        // Only meaningful when a real path was requested: landing on the bare
        // root ("/" or empty) means the deep link was thrown away.
        const wantPath = want.pathname.replace(/\/+$/, '');
        const gotPath = got.pathname.replace(/\/+$/, '');
        if (wantPath.length > 1 && gotPath === '' && !got.search) {
          return { hit: `redirected to homepage (wanted ${want.pathname})`, len: 0, cf: false };
        }
      } catch { /* unparseable URL — skip this check */ }

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
      // an empty stub) has nothing to capture. An empty stub is the classic
      // HEADLESS bot-detection signature (IMDb/Amazon/Akamai serve a near-empty
      // body to headless Chrome but render normally in a real window), so mark it
      // retry-eligible headed even though it's not a Cloudflare challenge.
      if (t.length < 20) return { hit: 'empty body (likely iframe wall / stub / headless bot-block)', len: t.length, cf: true };
      const low = t.toLowerCase();
      // STRONG CAPTCHA phrases — so distinctive they NEVER occur in real article
      // prose, so we check them BEFORE the length cap. Some walls (Walmart's
      // PerimeterX "Robot or human?", Genius's "Scrrrr!!") render a chunk of
      // footer/legal boilerplate that pushes the body past 1500 chars, so the
      // generic length gate below would let the wall through and it gets CAPTURED
      // (100%-coverage, no-chrome — the scorer thinks it's a healthy tiny page).
      // These clear on a HEADED retry (real window + cf_clearance), so cf:true.
      const STRONG = [
        'robot or human', "make sure you're a human", 'make sure you are a human',
        'we have to make sure you', 'press & hold to confirm', 'press and hold to confirm',
      ];
      const strongHit = STRONG.find(s => low.includes(s));
      if (strongHit) return { hit: strongHit, len: t.length, cf: true };
      // Only treat longer pages as an interstitial when SHORT enough that a real
      // article's prose couldn't be there — a real article merely containing
      // "access denied" in its body stays.
      if (t.length > 1500) return null;
      // CF/bot-CHALLENGE signatures — these can clear when retried HEADED.
      const CHALLENGE = [
        'performing security verification', 'checking your browser',
        'verify you are human', 'verifying you are human',
        'enable javascript and cookies to continue', 'needs to review the security',
        'attention required', 'ddos protection by', 'just a moment',
        'are you a robot', 'unusual traffic', 'not a bot',
        'access is temporarily restricted', 'we detected unusual activity',
        // phys.org/techxplore: "Checking your connection … to prevent automated
        // abuse", and a bare "400 / blocked by our server's security policies".
        // Both are SHORT and chrome-free, so without these signatures the scorer
        // read the block page as a healthy 92%-coverage clip — a block scoring
        // well is worse than an honest skip. CF-shaped, so retry headed.
        'checking your connection', 'prevent automated abuse',
        'blocked by our server', 'security policies',
        // UA-sniff "unsupported browser" stubs (music.youtube.com serves
        // "Sorry, YouTube Music is not optimized for your browser" to the
        // headless UA). Short + chrome-free, so the scorer read it as a healthy
        // 100%-coverage clip — same false-pass class as the phys.org block
        // above. The HEADED retry sends the real branded-Chrome UA and gets the
        // actual page, so this is CF-shaped (retryable), not a hard block.
        'is not optimized for your browser', 'unsupported browser',
        'browser is not supported', 'update your browser to continue',
        // Rate-limit stubs. postguam served a bare "Too Many Requests /
        // client_ip / request_id" page after the sweep hit it too fast, and the
        // scorer read that as a healthy 100%-coverage clip (composite 0.200 —
        // it even reached the worst-decile list as a fake finding). A pause +
        // retry clears it, so this is CHALLENGE (cf:true), not HARD.
        // NB: only UNAMBIGUOUS phrases here. 'slow down' and 'try again later'
        // were tried and rejected — they occur in ordinary prose ("the council
        // voted to slow down construction… residents could try again later"),
        // and the 1500-char gate above would not save a SHORT real article.
        'too many requests', '429 too many', 'rate limit exceeded',
        // Bot-block interstitials that explain themselves instead of naming
        // the wall. Bloomberg serves "Why did this happen? … Block reference
        // ID: <uuid>" and it scored ok 0.111 as if it were an article.
        'block reference id', 'why did this happen',
      ];
      // HARD-block signatures — a headed retry won't help (IP/account level).
      const HARD = [
        'ray id', '403 forbidden', '403 error', 'access denied',
        'access to this page has been denied', 'request blocked',
        'you have been blocked', 'temporarily unavailable', 'rate limited',
        // Reddit says "You'VE been blocked by network security" — the
        // contraction missed 'you have been blocked' and the block page
        // scored ok 0.076 at 100% coverage, hiding the fact that Reddit's
        // hand-tuned tagger was never exercised at all.
        "you've been blocked", 'blocked by network security',
        // SEC.gov: "Your Request Originates from an Undeclared Automated
        // Tool" — a long, well-formed prose page, so it scored ok 0.053 at
        // 98.6% coverage. Length gates can never catch this one; only the
        // signature can.
        'undeclared automated tool', 'declare your traffic',
        // techxplore serves a bare "400 / Your request has been blocked by our
        // server's security policies." page. It is SHORT and chrome-free, so
        // without this signature the scorer read it as a healthy 92%-coverage
        // clip — a block page scoring well is worse than a skip.
      ];
      const cfHit = CHALLENGE.find(s => low.includes(s));
      if (cfHit) return { hit: cfHit, len: t.length, cf: true };
      const hardHit = HARD.find(s => low.includes(s));
      return hardHit ? { hit: hardHit, len: t.length, cf: false } : null;
    }, url);
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

      // Select THIS capture's row, never `.first()`. The real extension's
      // web-bridge also pushes every clip already in IndexedDB (leftovers from
      // previous sweep runs) into the same store, so `.first()` — and even a
      // title match, since a re-run re-posts the same title — could land on a
      // PRIOR domain's clip and silently screenshot+score the wrong page (8
      // domains shared one stale Amazon clip image before this was found).
      // A per-run marker in the title makes the row unambiguous.
      const marker = `dxsweep-${d.name}-${Date.now()}`;
      (cap as Record<string, unknown>).title = `${String((cap as { title?: unknown }).title ?? d.name)} ​${marker}`;
      const row = libPage.locator('article.clip', { hasText: marker }).first();
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
      // The detail panel can keep showing a PREVIOUS clip's body for a beat after
      // the click (and a click can land while the list is re-rendering). Re-click
      // until the panel's title is THIS capture's, so the screenshot and the
      // score can never describe a different site.
      const detailTitle = libPage.locator('.detail-title', { hasText: marker }).first();
      let detailReady = false;
      for (let attempt = 0; attempt < 3 && !detailReady; attempt++) {
        await row.click();
        try {
          await detailTitle.waitFor({ state: 'visible', timeout: 10_000 });
          detailReady = true;
        } catch { /* stale render — click again */ }
      }
      if (!detailReady) {
        rec.skipReason = 'detail panel never showed this capture (stale render)';
        persist(rec);
        return rec;
      }
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

      // SWEEP_DUMP_HTML=1 saves the RENDERED clip markup next to the images.
      // A screenshot shows THAT a clip is wrong; only the markup shows WHY
      // (which attributes survived, what the sanitiser kept). Feeds the offline
      // clip-width probe so a fix can be iterated without re-hitting the site.
      if (process.env.SWEEP_DUMP_HTML) {
        const html = await clipBody.evaluate(el => el.innerHTML).catch(() => '');
        if (html) writeFileSync(resolve(art.dir, `${d.name}--clip.html`), html, 'utf8');
      }

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
      // Drop the row-disambiguation marker so the cast renders the real title.
      (cap as Record<string, unknown>).title =
        String((cap as { title?: unknown }).title ?? '').replace(/\s*​?dxsweep-\S+$/, '');
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

/**
 * Run captureDomain under a hard per-domain deadline.
 *
 * `captureDomain` is failure-ISOLATED (every throw becomes a skip record) but it
 * was never TIME-boxed, and the individual awaits inside it don't all carry
 * timeouts — so one domain that blocks in capture/render/cast stalls the entire
 * serial sweep until the ~4.4h whole-test budget fires. Observed 2026-08-17:
 * storygraph loaded fine (no gate — its source screenshot is a perfect book
 * page) and then wedged for 23+ minutes with zero artifact writes, blocking the
 * last 6 domains of the headed-retry pass.
 *
 * On timeout we persist an honest skip and move on, preserving the file's stated
 * contract that one bad domain can never abort the sweep.
 */
const DOMAIN_TIMEOUT_MS = Number(process.env.SWEEP_DOMAIN_TIMEOUT_MS ?? 240_000);

// Seconds to wait between domains. Hitting unrelated domains back-to-back at
// machine speed is ITSELF the bot signal — no single request looks wrong, the
// cadence does. An unpaced 5-domain run (the last three inside 28s, following an
// earlier sweep ~30 min before) got medium a Cloudflare "ray id" page and reddit
// a "blocked by network security" page, while the same URLs had captured cleanly
// hours earlier. Both are HARD signatures, so the Pass-2 headed retry is
// deliberately powerless against them — pacing is the only defence, which is why
// this defaults ON rather than being opt-in. `finder-diag-probe` learned the
// same lesson first (DIAG_GAP); the sweep had no equivalent until now.
// SWEEP_GAP=0 disables it (offline/localhost corpora, or a single domain).
const GAP_SECS = Number(process.env.SWEEP_GAP ?? 20);

/** Pace before each domain except the first of a pass. */
async function paceBeforeDomain(first: boolean, name: string): Promise<void> {
  if (first || GAP_SECS <= 0) return;
  // eslint-disable-next-line no-console
  console.log(`   … pausing ${GAP_SECS}s before ${name} (avoid rate-limit)`);
  await new Promise(r => setTimeout(r, GAP_SECS * 1_000));
}

async function captureDomainDeadlined(
  ctx: BrowserContext, d: DomainEntry, ctxIsHeaded = false,
): Promise<SweepDriverRecord> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SweepDriverRecord>((res) => {
    timer = setTimeout(() => {
      const rec: SweepDriverRecord = {
        domain: d.name, url: d.url, ranAt: new Date().toISOString(), status: 'skip',
        skipReason: `domain timeout (>${Math.round(DOMAIN_TIMEOUT_MS / 1000)}s — wedged in capture/render/cast)`,
      };
      persist(rec);
      res(rec);
    }, DOMAIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([captureDomain(ctx, d, ctxIsHeaded), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Merge one pass's records into the accumulator (by domain), preferring an 'ok'
// over a prior 'skip' (the headed retry can only improve a domain's outcome).
function mergeRecord(acc: Map<string, SweepDriverRecord>, rec: SweepDriverRecord): void {
  const prev = acc.get(rec.domain);
  if (!prev || (prev.status !== 'ok' && rec.status === 'ok')) acc.set(rec.domain, rec);
}

test('corpus-sweep: capture + score the corpus domains, build ranked gallery', async () => {
  test.skip(!process.env.SWEEP, 'set SWEEP=1 to run the broad-web corpus sweep');
  // ~75s budget per domain (nav + capture + render + 3 screenshots + cast), plus
  // headroom for the headed-retry pass over the CF-challenged subset.
  // 75s/domain is the steady-state cost, but a slow site plus the detail-panel
  // re-click retries can exceed it — and on a SMALL run (one domain, when
  // verifying a fix) that lands inside the whole test's budget with no slack.
  // Floor the budget so short runs aren't killed mid-capture.
  //
  // A domain can ALSO be retried HEADED, and a headed gate wait is up to ~3.5min
  // on its own (TOTAL_POLLS * 2s) — far more than the 75s steady-state figure.
  // A `SWEEP_ONLY` run of 8 domains therefore got 720s total and was KILLED
  // mid-retry (observed 2026-08-17, right after GATE_RE was widened so CF walls
  // correctly hold the window open). Budget a possible headed retry for EVERY
  // domain at the per-domain deadline, so the whole-test timeout can never be
  // tighter than the per-domain timeouts it contains.
  //
  // SWEEP_GAP adds a fixed pause before every domain but the first, and a domain
  // can be visited in TWO passes (headless, then the headed retry), so budget the
  // gap twice per domain. Omitting this would re-create the mid-run kill above.
  const perDomain = 75_000 + DOMAIN_TIMEOUT_MS + GAP_SECS * 2_000;
  test.setTimeout(Math.max(DOMAINS.length * perDomain, 300_000) + 120_000);

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR ??
    resolve(__dirname, '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const profileDirectory = process.env.PROFILE_DIR ?? 'Profile 3';
  const channel = (process.env.BROWSER_CHANNEL as 'chrome') ?? 'chrome';

  const acc = new Map<string, SweepDriverRecord>();

  // Split the corpus: PerimeterX-walled sites run HEADED-FIRST (Pass 0) and are
  // NEVER hit headless; everyone else runs headless (Pass 1). See PERIMETERX_SITES.
  // Headed-first group = PerimeterX walls + logged-in social feeds + the
  // Cloudflare-headed sites (see above).
  const headedFirst = (n: string): boolean =>
    PERIMETERX_SITES.has(n) || SOCIAL_FEED_SITES.has(n) || HEADED_ONLY_SITES.has(n);
  const pxDomains = DOMAINS.filter(d => headedFirst(d.name));
  const headlessDomains = DOMAINS.filter(d => !headedFirst(d.name));

  // ── Pass 0: HEADED-FIRST for PerimeterX sites (before any headless hit) ──
  // A clean headed session's FIRST impression is the best chance to clear
  // PerimeterX; the auto press-and-hold + sustained-clear (in captureDomain, gated
  // on ctxIsHeaded) solves the gate without the user. Skipped entirely when there
  // are none, or via SWEEP_NO_PX_FIRST=1 (then they'd only be reachable headless,
  // which is discouraged — kept as an escape hatch).
  if (pxDomains.length && !process.env.SWEEP_NO_PX_FIRST) {
    // eslint-disable-next-line no-console
    console.log(`\n── headed-first pass (${pxDomains.length}) — PerimeterX + social feeds + headed-only: ${pxDomains.map(d => d.name).join(', ')} ──`);
    const { ctx: pxCtx } = await launchWithExtension({
      rawUserDataDir, profileDirectory, channel, preinstalledExtension: true, headed: true,
      clearSwCacheForRawDir: true,
    });
    try {
      for (const [i, d] of pxDomains.entries()) {
        await paceBeforeDomain(i === 0, d.name);
        const rec = await captureDomainDeadlined(pxCtx, d, true);
        mergeRecord(acc, rec);
        // eslint-disable-next-line no-console
        console.log(rec.status === 'ok'
          ? `OK⊕   ${d.name.padEnd(20)} composite=${rec.scores!.composite.toFixed(3)} (px-headed)` +
              (rec.scores!.flags.length ? `  [${rec.scores!.flags.join(', ')}]` : '')
          : `SKIP⊕ ${d.name.padEnd(20)} ${rec.skipReason} (px-headed)`);
      }
    } finally {
      await pxCtx.close();
    }
  }

  // ── Pass 1: HEADLESS (out of the user's way) — everyone EXCEPT PerimeterX ─
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
    // Clear clips left in IndexedDB by earlier runs before capturing anything —
    // see purgeStoredClips (they made the sweep score the wrong site).
    const purged = await purgeStoredClips(ctx);
    if (purged) {
      // eslint-disable-next-line no-console
      console.log(`   ⌫ purged ${purged} stored clip(s) from a previous run`);
    }
    for (const [i, d] of headlessDomains.entries()) {
      await paceBeforeDomain(i === 0, d.name);
      const rec = await captureDomainDeadlined(ctx, d);
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
  // EXCLUDE PerimeterX sites — they already had their headed shot in Pass 0, and
  // re-hitting them would only escalate the wall (and they'd have been captured or
  // legitimately skipped there, never marked `challenged` from a headless pass).
  const cfDomains = DOMAINS.filter(d => acc.get(d.name)?.challenged
    && !PERIMETERX_SITES.has(d.name) && !SOCIAL_FEED_SITES.has(d.name));
  if (cfDomains.length && !process.env.SWEEP_NO_HEADED_RETRY) {
    // eslint-disable-next-line no-console
    console.log(`\n── headed retry for ${cfDomains.length} CF-challenged domain(s): ${cfDomains.map(d => d.name).join(', ')} ──`);
    const { ctx: headedCtx } = await launchWithExtension({
      rawUserDataDir, profileDirectory, channel, preinstalledExtension: true, headed: true,
      clearSwCacheForRawDir: true,
    });
    try {
      for (const [i, d] of cfDomains.entries()) {
        await paceBeforeDomain(i === 0, d.name);
        // `true` = this context IS headed. It was omitted before, so the gate-wait
        // loop (gated on ctxIsHeaded) NEVER RAN in the headed-retry pass — the one
        // pass whose whole purpose is clearing walls in a real window. A CF wall
        // therefore fell straight through to the interstitial detector and skipped
        // in ~10s, which is why librarything's window closed under the user's click
        // even after GATE_RE was widened. Both halves are needed.
        const rec = await captureDomainDeadlined(headedCtx, d, true);
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
