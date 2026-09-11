// Does arriving from a GOOGLE SEARCH RESULT get past the walls that a direct
// navigation cannot?
//
// The corpus sweep's 11 persistently-walled domains (politico, discogs,
// sciencemag, boardgamegeek, librarything, rateyourmusic, lemmy-thread,
// netflix-techblog, producthunt, openai-blog, medium-generic) fail identically
// on a bare page.goto() AND on the existing SWEEP_CLICK_NAV path — but that path
// clicks a link on a `data:` URL, which sends NO Referer and has no search
// lineage. The user's observation is that these sites load fine after being
// reached through a browser search, and [[project_sweep_wall_referrer_warmup]]
// records medium specifically needing "a Google search result, not even a
// gallery link".
//
// This probe isolates that ONE variable. For each domain it:
//   1. opens google.com and searches for the article URL,
//   2. clicks the matching organic result (a real gesture, real cross-site
//      lineage, google.com as the referrer),
//   3. reports whether the landed page is walled or real content.
// It then does a bare goto() of the same URL in a fresh context as a control,
// so the comparison is within-run rather than against yesterday's log.
//
// Diagnostic only — writes test-output/google-referral-probe.txt and screenshots.
// Run (Chrome fully closed; uses the warm Profile 3):
//   GREF=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=google-referral-probe
// Options: GREF_ONLY=politico,discogs   GREF_GAP=<seconds, default 30>

import { test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');

const DEFAULT_TARGETS = [
  'politico', 'discogs', 'sciencemag', 'boardgamegeek', 'librarything',
  'rateyourmusic', 'lemmy-thread', 'netflix-techblog', 'producthunt',
  'openai-blog', 'medium-generic',
];

interface DomainEntry { name: string; url: string }

/** Same wall signatures the sweep's interstitial detector uses. */
const WALL_RE = /(performing security verification|verifying you are human|ray id|press ?& ?hold|robot or human|access denied|are you a human|just a moment|too many requests|enable javascript and cookies)/i;

async function classify(page: Page): Promise<{ verdict: string; chars: number; title: string }> {
  const title = await page.title().catch(() => '');
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const chars = body.trim().length;
  if (WALL_RE.test(body) || WALL_RE.test(title)) return { verdict: 'WALLED', chars, title };
  if (chars < 400) return { verdict: 'EMPTY', chars, title };
  return { verdict: 'CONTENT', chars, title };
}

test('google-referral-probe: does arriving via a Google result beat the wall?', async () => {
  test.skip(!process.env.GREF, 'set GREF=1 to run the Google-referral probe');

  const domains: DomainEntry[] = (JSON.parse(
    readFileSync(resolve(__dirname, '..', '..', 'fixtures', 'corpus-domains.json'), 'utf8'),
  ) as { domains: DomainEntry[] }).domains;

  const want = new Set((process.env.GREF_ONLY ?? DEFAULT_TARGETS.join(',')).split(',').map(s => s.trim()));
  const targets = domains.filter(d => want.has(d.name));
  const gap = Number(process.env.GREF_GAP ?? 30);
  test.setTimeout(targets.length * 180_000 + 120_000);

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR
    ?? resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome');

  // HEADED: these sites refuse headless outright, which would confound the one
  // variable this probe exists to isolate.
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: true,
  });

  const lines: string[] = [`Google-referral probe — ${new Date().toISOString()}`, ''];

  try {
    for (const [i, d] of targets.entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, gap * 1_000));

      // ── A: via a Google search result ──────────────────────────────────
      let viaGoogle = { verdict: 'ERROR', chars: 0, title: '' };
      let clicked = false;
      const gp = await ctx.newPage();
      try {
        await gp.goto('https://www.google.com/search?q=' + encodeURIComponent(d.url),
          { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await gp.waitForTimeout(2_500);

        // Click the first ORGANIC result for the target host. Scope to the
        // results container: a bare `a[href*="<host>"]:visible` also matches
        // Google's own chrome and (measured 2026-09-06) hit the signed-in
        // account panel, opening an overlay while the page stayed on google.com.
        const host = new URL(d.url).hostname.replace(/^www\./, '');
        const link = gp
          .locator('#search a[href^="http"]:visible, #rso a[href^="http"]:visible')
          .locator(`xpath=self::a[contains(@href, "${host}")]`)
          .first();
        if (await link.count()) {
          clicked = true;
          await link.click({ timeout: 10_000 }).catch(() => undefined);
          await gp.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => undefined);
          await gp.waitForTimeout(4_000);
          // Did we actually LEAVE Google? Without this check a failed click
          // scores the Google SERP itself as CONTENT — which is exactly how an
          // earlier run produced a bogus "11 of 11 domains cleared" result.
          const landed = (() => {
            try { return new URL(gp.url()).hostname.replace(/^www\./, ''); } catch { return ''; }
          })();
          viaGoogle = /(^|\.)google\./.test(landed)
            ? { verdict: 'NO-CLICK', chars: 0, title: landed }
            : await classify(gp);
        } else {
          viaGoogle = { verdict: 'NO-RESULT', chars: 0, title: await gp.title().catch(() => '') };
        }
        await gp.screenshot({ path: resolve(OUT, `gref-${d.name}-google.png`) }).catch(() => undefined);
      } catch (e) {
        viaGoogle = { verdict: 'ERROR', chars: 0, title: String(e).slice(0, 80) };
      } finally {
        await gp.close().catch(() => undefined);
      }

      await new Promise(r => setTimeout(r, gap * 1_000));

      // ── B: control — bare goto of the same URL ─────────────────────────
      let direct = { verdict: 'ERROR', chars: 0, title: '' };
      const dp = await ctx.newPage();
      try {
        await dp.goto(d.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await dp.waitForTimeout(4_000);
        direct = await classify(dp);
        await dp.screenshot({ path: resolve(OUT, `gref-${d.name}-direct.png`) }).catch(() => undefined);
      } catch (e) {
        direct = { verdict: 'ERROR', chars: 0, title: String(e).slice(0, 80) };
      } finally {
        await dp.close().catch(() => undefined);
      }

      const verdict = viaGoogle.verdict === 'CONTENT' && direct.verdict !== 'CONTENT'
        ? '  <<< GOOGLE PATH WINS'
        : viaGoogle.verdict === direct.verdict ? '  (no difference)' : '';
      const line = `${d.name.padEnd(18)} google=${viaGoogle.verdict.padEnd(10)}(${String(viaGoogle.chars).padStart(6)}ch, clicked=${clicked})  direct=${direct.verdict.padEnd(10)}(${String(direct.chars).padStart(6)}ch)${verdict}`;
      // eslint-disable-next-line no-console
      console.log(line);
      lines.push(line);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  writeFileSync(resolve(OUT, 'google-referral-probe.txt'), lines.join('\n') + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`\nreport -> ${resolve(OUT, 'google-referral-probe.txt')}`);
});
