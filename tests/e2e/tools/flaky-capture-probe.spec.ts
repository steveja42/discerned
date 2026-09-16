// Why does ONE page capture well on some runs and near-empty on others?
//
// Politico measured 86 / 5 / 85 / 5 / 87 % text coverage across five runs of
// identical code, with `bodySettle` showing the page fully hydrated and stable
// in BOTH the good and the bad runs — so it is not a hydration race, and a
// single capture cannot tell the two apart. Only repetition can.
//
// This loads the page ONCE (so a gate is cleared once, by hand if needed) and
// then captures N times against that same settled DOM, recording the pipeline
// census for every attempt. If the same DOM yields both outcomes, the
// non-determinism is inside the capture pipeline, and the census names the
// stage where the runs diverge.
//
// Run with Chrome fully closed (the warm profile is locked):
//   FLAKY=1 FLAKY_URL=<url> [FLAKY_N=8] [FLAKY_WAIT=180] \
//     pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=flaky-capture-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnPage } from '../helpers/activateExtension';
import { waitForBodySettled } from '../helpers/waitForBodySettled';

test.describe.configure({ mode: 'serial' });

test('same page, N captures — does the pipeline diverge?', async () => {
  test.skip(!process.env.FLAKY, 'set FLAKY=1 to run the flaky-capture probe');

  const url = process.env.FLAKY_URL
    ?? 'https://www.politico.com/news/2026/07/21/nasa-nuclear-mars-mission-cost-01005610';
  const n = Number(process.env.FLAKY_N ?? 8);
  const waitSecs = Number(process.env.FLAKY_WAIT ?? 180);
  test.setTimeout(waitSecs * 1_000 + n * 60_000 + 120_000);

  const out: string[] = [];
  const rawUserDataDir = resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory: 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: true,
  });

  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const census: string[] = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/census|layout-finder|selfCheck|narrowed|handoff/i.test(t)) census.push(t.slice(0, 300));
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    // Hold for a human to clear any gate — the page must be loaded ONCE and
    // then reused, so the DOM is a constant across every capture below.
    const deadline = Date.now() + waitSecs * 1_000;
    // eslint-disable-next-line no-console
    console.log(`   ⏸ holding up to ${waitSecs}s — clear any gate now…`);
    while (Date.now() < deadline) {
      const gated = await page.evaluate(() => {
        const t = (document.body?.innerText ?? '').toLowerCase();
        return t.length < 40 || /press\s*&?\s*hold|verify you are human|robot or human/.test(t);
      }).catch(() => true);
      if (!gated) break;
      await page.waitForTimeout(2_000);
    }

    const settle = await waitForBodySettled(page);
    out.push(`URL: ${url}`);
    out.push(`settle: ${JSON.stringify(settle)}`);

    await activateExtensionOnPage(page);

    for (let i = 0; i < n; i++) {
      census.length = 0;
      const res = (await page.evaluate(() => new Promise<{
        len?: number; text?: string; err?: string; html?: string; title?: string;
      }>((resolve) => {
        const t = setTimeout(() => resolve({ err: 'timeout' }), 40_000);
        const on = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
          clearTimeout(t); window.removeEventListener('message', on);
          if (e.data.error) { resolve({ err: String(e.data.error) }); return; }
          const c = e.data.capture ?? {};
          resolve({
            len: (c.bodyText ?? '').length,
            text: (c.bodyText ?? '').slice(0, 60),
            html: (c.bodyHtml ?? '') as string,
            title: (c.title ?? '') as string,
          });
        };
        window.addEventListener('message', on);
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      }))) as { len?: number; text?: string; err?: string; html?: string; title?: string };

      // Re-measure the page each round: if the DOM itself changed between
      // captures, the pipeline is not the variable and the census would mislead.
      const nowLen = await page.evaluate(
        () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
      ).catch(() => -1);

      // Keep the first capture's HTML so the tagger's real output can be read
      // offline — a probe that prints only lengths cannot answer "what did it
      // actually produce?".
      if (i === 0 && res.html) {
        writeFileSync(resolve(__dirname, '..', '..', '..', 'test-output', 'flaky-capture-body.html'), res.html, 'utf8');
      }
      out.push('');
      out.push(`── capture ${i + 1}/${n}: bodyText=${res.len ?? `ERR ${res.err}`} pageText=${nowLen} title="${(res.title ?? '').slice(0, 50)}"`);
      if (res.text) out.push(`   head: ${res.text.replace(/\s+/g, ' ')}`);
      for (const c of census) out.push(`   ${c}`);
      await page.waitForTimeout(1_500);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  const dir = resolve(__dirname, '..', '..', '..', 'test-output');
  mkdirSync(dir, { recursive: true });
  const report = out.join('\n');
  writeFileSync(resolve(dir, 'flaky-capture.txt'), report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});
