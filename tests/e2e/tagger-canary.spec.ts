// Phase 3.1 — weekly canary for the per-site taggers.
//
// For each tagger's live target (helpers/taggerCanaryTargets.ts) this navigates
// to the real page and runs that tagger's SELECTOR-ANCHOR MANIFEST (Phase 3.2,
// declared in capture.ts SITE_TAGGERS) against the live DOM via the extension's
// __DISCERNED_TEST_ANCHORS bridge. A dead anchor (zero matches) means the site
// redesigned out from under the tagger — the test FAILS and names the exact
// dead selector, so a redesign is caught within a week instead of by accident.
//
// This is deliberately LIGHTWEIGHT vs the full *-visual specs: no capture, no
// render, no screenshot — just "does each load-bearing selector still match
// something?". That makes it cheap enough to schedule weekly (see the
// tagger-canary GitHub Actions workflow) and fast enough that a failure points
// straight at the broken selector.
//
// Run manually:  $env:CANARY='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=tagger-canary
//
// A page that won't LOAD (Cloudflare hard-deny, network blip) is reported as a
// skip for that target, NOT a failure — the canary's job is to detect selector
// death, not to flake on infra. A tagger whose anchors are all dead, or any
// individual dead anchor, is a hard failure.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';
import { TAGGER_CANARY_TARGETS, type TaggerAnchorReport } from './helpers/taggerCanaryTargets';

test.describe.configure({ mode: 'serial' });

test('tagger-canary: every tagger anchor still matches the live DOM', async () => {
  test.skip(!process.env.CANARY, 'set CANARY=1 to run the weekly tagger canary');
  test.setTimeout(TAGGER_CANARY_TARGETS.length * 90_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

  const profile = process.env.PROFILE ?? 'test';
  const headed = process.env.PWDEBUG_HEADED === '0' ? false : !!process.env.PWDEBUG_HEADED;
  const { ctx } = await launchWithExtension({ profile, headed });

  const summary: string[] = [];
  const failures: string[] = [];
  const skips: string[] = [];

  try {
    for (const target of TAGGER_CANARY_TARGETS) {
      const url = process.env[target.urlEnv] || target.url;
      const label = target.label ?? target.name;
      const page = await ctx.newPage();
      try {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          // Give the SPA time to paint the content the tagger anchors depend on.
          await page.waitForSelector(target.renderWait, { timeout: 30_000 });
          await page.waitForTimeout(2_000);
        } catch (navErr) {
          const msg = `SKIP  ${label.padEnd(14)} — page did not load/render (${(navErr as Error).message.split('\n')[0]})`;
          skips.push(msg);
          summary.push(msg);
          continue;
        }

        const report = (await page.evaluate(
          ({ hostOverride }) =>
            new Promise<TaggerAnchorReport | null>((resolvePromise, reject) => {
              const timer = setTimeout(() => reject(new Error('anchor check timeout')), 10_000);
              const onMessage = (e: MessageEvent) => {
                if (e.data?.type !== '__DISCERNED_TEST_ANCHORS_RESULT') return;
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                resolvePromise(e.data.report ?? null);
              };
              window.addEventListener('message', onMessage);
              window.postMessage({ type: '__DISCERNED_TEST_ANCHORS', hostOverride }, window.location.origin);
            }),
          { hostOverride: target.hostOverride },
        )) as TaggerAnchorReport | null;

        if (!report) {
          const msg = `FAIL  ${label.padEnd(14)} — no tagger resolved for host ${target.hostOverride} (registry/target drift)`;
          failures.push(msg);
          summary.push(msg);
          continue;
        }

        // Shape-specific anchors: selectors only THIS page shape renders, which
        // the shared (variant-grouped) manifest can't assert on its own. Counted
        // in the page and folded into the report so they fail identically.
        //
        // NB: plain `querySelectorAll`, so unlike the manifest's
        // `querySelectorAllDeep` this does NOT pierce shadow roots. Fine for the
        // current users (primal is shadow-free); if you add extraAnchors for a
        // shadow-DOM site, route them through the __DISCERNED_TEST_ANCHORS
        // bridge instead of counting them here.
        if (target.extraAnchors?.length) {
          const extra = await page.evaluate(
            sels => sels.map(selector => ({
              selector,
              count: (() => {
                try { return document.querySelectorAll(selector).length; } catch { return 0; }
              })(),
            })),
            target.extraAnchors,
          );
          report.anchors = [...report.anchors, ...extra];
          report.dead = [...report.dead, ...extra.filter(a => a.count === 0).map(a => a.selector)];
        }

        const detail = report.anchors.map(a => `${a.selector} → ${a.count}`).join('\n                  ');
        if (report.dead.length > 0) {
          const msg = `FAIL  ${label.padEnd(14)} — DEAD anchor(s): ${report.dead.join(' | ')}\n                  ${detail}`;
          failures.push(msg);
          summary.push(msg);
        } else {
          summary.push(`OK    ${label.padEnd(14)} — ${report.anchors.length} anchors live\n                  ${detail}`);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await ctx.close();
  }

  const report = [
    `Tagger canary — ${new Date().toISOString()}`,
    ``,
    ...summary,
    ``,
    `${TAGGER_CANARY_TARGETS.length} targets · ${failures.length} failed · ${skips.length} skipped`,
  ].join('\n');
  writeFileSync(resolve(outDir, 'tagger-canary.txt'), report + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log('\n' + report + '\n');

  // Hard-fail only on a dead selector; page-load flakes are skips, not failures.
  expect(failures, `Dead tagger selectors:\n${failures.join('\n')}`).toEqual([]);
});
