// Headed visual verification of a Medium article capture.
// Uses a persistent profile under .vscode/browser-test-profiles/test so the
// session can warm up past Cloudflare and stay warm across runs. Logs / cookies
// in that dir survive between invocations; gitignored.
//
// Run with: MEDIUM_VISUAL=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=medium-visual
//
// To use a different profile (e.g. once you log into a site): set PROFILE=foo
// — the spec creates/reuses .vscode/browser-test-profiles/foo.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const URL =
  process.env.MEDIUM_URL ||
  'https://medium.com/cube-bitcoin/introducing-cube-8b3702e470a5';

test.describe.configure({ mode: 'serial' });

test('medium-visual: capture article via headed Brave + render in /library', async () => {
  test.skip(!process.env.MEDIUM_VISUAL, 'set MEDIUM_VISUAL=1 to run this');
  test.setTimeout(240_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const profile = process.env.PROFILE ?? 'test';
  const { ctx } = await launchWithExtension({ profile, headed: true });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('harvest') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    // Cloudflare warm-up — first visit on a fresh profile may serve a challenge.
    // Move the mouse + scroll a bit to look human, then poll for up to 60s for
    // the article title to appear. If a visible Brave window is open and the
    // challenge needs a click, the human can solve it during this window.
    await page.mouse.move(400, 300);
    await page.mouse.move(500, 400, { steps: 8 });
    await page.evaluate(() => window.scrollBy(0, 100));
    let cleared = false;
    for (let i = 0; i < 60; i++) {
      const hasTitle = await page.evaluate(() => !!document.querySelector('[data-testid="storyTitle"], h1[data-testid="storyTitle"]'));
      if (hasTitle) { cleared = true; break; }
      if (i % 10 === 0) {
        // eslint-disable-next-line no-console
        console.log(`[probe] waiting for Cloudflare/article (${i}s)…`);
      }
      await page.waitForTimeout(1_000);
    }
    if (!cleared) {
      // eslint-disable-next-line no-console
      console.warn('[probe] storyTitle not detected after 60s — Cloudflare may still be blocking. The fingerprint anti-detection helps but isn\'t 100% reliable.');
    }
    await page.waitForTimeout(2_000); // hydration

    await page.screenshot({ path: out('medium-source.png'), fullPage: false });

    // Dump the live byline + engagement DOM for reference.
    const live = await page.evaluate(() => {
      const findHeader = () => {
        const all = Array.from(document.querySelectorAll('*'));
        const candidates = all.filter(el => {
          if (el.children.length === 0) return false;
          const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (txt.length > 600) return false;
          return /\bFollow\b/.test(txt) && /\d+\s*min read/i.test(txt);
        });
        if (candidates.length === 0) return null;
        const smallest = candidates.reduce<Element>((best, el) =>
          (el.textContent?.length ?? 0) < (best.textContent?.length ?? 0) ? el : best, candidates[0]);
        return smallest.outerHTML.slice(0, 4000);
      };
      const findEngagement = () => {
        const labels = ['clap', 'respond', 'comment', 'save', 'share', 'highlight'];
        const elements = Array.from(document.querySelectorAll('*')).filter(el => {
          const t = (el.getAttribute('aria-label') ?? '').toLowerCase();
          return labels.some(l => t.includes(l));
        });
        if (elements.length === 0) return null;
        const parents = new Map<Element, number>();
        for (const el of elements) {
          let p: Element | null = el.parentElement;
          while (p && p !== document.body) {
            parents.set(p, (parents.get(p) ?? 0) + 1);
            p = p.parentElement;
          }
        }
        let best: Element | null = null;
        let bestSize = Infinity;
        for (const [p, count] of parents) {
          if (count < 3) continue;
          const size = (p.textContent ?? '').length;
          if (size < bestSize) { best = p; bestSize = size; }
        }
        return best ? best.outerHTML.slice(0, 4000) : null;
      };
      return { header: findHeader(), engagement: findEngagement() };
    });
    writeFileSync(out('medium-live-dom.txt'),
      `--- HEADER ---\n${live.header ?? '(not found)'}\n\n--- ENGAGEMENT ---\n${live.engagement ?? '(not found)'}\n`,
      'utf8');

    // Capture via the dev test bridge.
    const cap = (await page.evaluate(async () => {
      return new Promise((resolveCap, rejectCap) => {
        const timer = setTimeout(() => rejectCap(new Error('capture timeout')), 30_000);
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (e.data.error) rejectCap(new Error(e.data.error));
          else resolveCap(e.data.capture);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    writeFileSync(out('medium-capture.json'),
      JSON.stringify({ ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').slice(0, 200000) }, null, 2),
      'utf8');

    // Sanity: title should not be Cloudflare's "Just a moment...". If it is,
    // the profile didn't clear the challenge.
    expect(cap.title, 'capture should not be Cloudflare interstitial').not.toContain('moment');

    // Render through /library and screenshot the top portion.
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/library', { waitUntil: 'networkidle' });
    await libPage.evaluate((capture) => {
      const clip = { capture, evaluation: { interest: 'Interesting', ethics: 'Honest', category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, cap);
    const row = libPage.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const clipBody = libPage.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
    await libPage.waitForTimeout(1500);

    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.setViewportSize({ width: 1280, height: Math.min(1600, Math.ceil(rect.height) + 100) });
      await libPage.waitForTimeout(400);
    }
    // Top 800px of the clip — the byline + engagement row + first paragraphs.
    await libPage.screenshot({
      path: out('medium-rendered-top.png'),
      clip: { x: 0, y: 0, width: 1280, height: 900 },
    });
    // Also a full-clip-body screenshot in case the byline is below the fold.
    await clipBody.screenshot({ path: out('medium-rendered-full.png') });

    // Dump just the dx-header + dx-stats markers from the rendered clip-body so
    // we can see what the generic tagger picked up (if anything).
    const dxInfo = await clipBody.evaluate(root => {
      const targets = Array.from(root.querySelectorAll('.dx-header, .dx-author, .dx-stats, .dx-stats--end'));
      return targets.map(el => ({
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
        childCount: el.children.length,
      }));
    });
    writeFileSync(out('medium-dx-markers.json'), JSON.stringify(dxInfo, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log('\n[probe] dx markers in rendered clip:', JSON.stringify(dxInfo, null, 2));
  } finally {
    await ctx.close();
  }
});
