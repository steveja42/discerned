// Diagnostic for the Instagram reel capture defect.
//
// Answers, against the REAL page (not an inferred shape):
//   1. Is the reel actually a dialog layered over a feed, or its own page?
//   3. What does the CURRENT pipeline capture (the reported bug: background
//      instead of the visible reel)?
//   4. Is the reel's content (video, caption, author) even in the DOM, or is it
//      login-walled / canvas-rendered and therefore uncapturable regardless?
//
// Question 4 is the one that decides whether the Tier 0.5 plan is worth
// building at all: if the content isn't in the DOM, no capture root helps.
//
// Run (Chrome must be fully closed — warm profile lock):
//   IG=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=instagram-probe
// Options: IG_URL=<reel url>, IG_HEADED=1 (watch it / clear a login gate).

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const REEL_URL = process.env.IG_URL ?? 'https://www.instagram.com/reels/DbnxT2Duur8/';
// The reel page has TWO shapes and they differ structurally:
//   • DIRECT  — open /reels/<id>/ straight: its own page, NO dialog.
//   • CLICKED — open a profile/feed and click a reel: opens as a MODAL over the
//     feed, which is the case the user reported.
// IG_MODE=clicked drives the second. IG_FEED_URL picks the feed to click from.
const MODE = (process.env.IG_MODE ?? 'direct') as 'direct' | 'clicked';
const FEED_URL = process.env.IG_FEED_URL ?? 'https://www.instagram.com/hilaryagro/reels/';

test('instagram-probe: what is actually capturable on a reel page', async () => {
  test.skip(!process.env.IG, 'set IG=1 to run the Instagram probe');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome',
    preinstalledExtension: true,
    headed: !!process.env.IG_HEADED,
  });
  const report: string[] = [
    `Instagram reel probe — ${new Date().toISOString()}`,
    `mode: ${MODE}`,
    `url: ${MODE === 'clicked' ? FEED_URL + ' → click a reel' : REEL_URL}`,
  ];
  const page = await ctx.newPage();
  const tag = MODE === 'clicked' ? 'clicked' : 'direct';
  try {
    if (MODE === 'clicked') {
      // Land on the profile's reel GRID, then click a tile — this is the path
      // that opens the reel as a modal over the feed.
      await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(8_000);
      // The profile grid hydrates lazily (tiles start as canvas). Wait for real
      // anchors, and scroll once — the grid often only mounts on intersection.
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(3_000);
      await page.waitForSelector('a[href*="/p/"], a[href*="/reel"]', { timeout: 20_000 }).catch(() => undefined);
      const linkShapes = await page.evaluate(() => {
        const hrefs = Array.from(document.querySelectorAll('a[href]'))
          .map(a => (a as HTMLAnchorElement).getAttribute('href') ?? '');
        const count = (re: RegExp) => hrefs.filter(h => re.test(h)).length;
        return { total: hrefs.length, posts: count(/\/p\//), reels: count(/\/reel/), sample: hrefs.slice(0, 12) };
      });
      report.push(`link shapes on feed: ${JSON.stringify(linkShapes)}`);
      await page.screenshot({ path: resolve(OUT, 'instagram-feed-before-click.png') });
      const urlBefore = page.url();
      // Which grid tile to click. Reel tiles (/reel/<id>) navigate to the reels
      // PLAYER route; POST tiles (/p/<id>) are the ones that open as a modal
      // over the grid. IG_TILE selects which shape to exercise.
      const tileSel = process.env.IG_TILE === 'post' ? 'a[href*="/p/"]' : 'a[href*="/reel"]';
      const tile = page.locator(tileSel).first();
      const tiles = await page.locator(tileSel).count();
      report.push(`tile selector: ${tileSel}`);
      report.push(`\nreel tiles found on feed: ${tiles}`);
      if (!tiles) {
        report.push('NO REEL TILES — cannot exercise the clicked path (login wall?)');
      } else {
        await tile.click({ timeout: 15_000 }).catch(async () => {
          // Some tiles intercept pointer events; force it.
          await tile.click({ force: true, timeout: 15_000 });
        });
        await page.waitForTimeout(8_000);
        report.push(`url before click: ${urlBefore}`);
        report.push(`url after click:  ${page.url()}`);
        report.push(`navigated (full page load)? ${urlBefore === page.url() ? 'NO — same URL' : 'URL changed (may be SPA pushState)'}`);
      }
    } else {
      await page.goto(REEL_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(8_000); // SPA + video need time to mount
    }

    await page.screenshot({ path: resolve(OUT, `instagram-source-${tag}.png`), fullPage: false });

    // ── 1 + 4: page shape and whether content is reachable ────────────────
    const shape = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const txt = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], dialog')).map(d => {
        const r = d.getBoundingClientRect();
        const s = getComputedStyle(d);
        const t = (d.textContent ?? '').replace(/\s+/g, ' ').trim();
        const chain: string[] = [];
        let p: Element | null = d;
        for (let i = 0; i < 4 && p; i++) {
          chain.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : ''));
          p = p.parentElement;
        }
        return {
          tag: d.tagName.toLowerCase(), role: d.getAttribute('role'),
          ariaModal: d.getAttribute('aria-modal'), ariaLabel: d.getAttribute('aria-label'),
          pos: s.position, z: s.zIndex, display: s.display, visibility: s.visibility,
          w: Math.round(r.width), h: Math.round(r.height),
          share: +((r.width * r.height) / (vw * vh)).toFixed(2),
          textLen: t.length, textHead: t.slice(0, 100),
          video: d.querySelectorAll('video').length,
          img: d.querySelectorAll('img').length,
          btn: d.querySelectorAll('button, [role="button"]').length,
          chain: chain.join(' < '),
          // Is the page behind it marked inert? The tell my guards record.
          siblingsHidden: Array.from(document.body.children)
            .filter(c => c !== d && !c.contains(d))
            .some(c => c.getAttribute('aria-hidden') === 'true' || c.hasAttribute('inert')),
        };
      });
      const videos = Array.from(document.querySelectorAll('video')).map(v => {
        const r = v.getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          poster: (v as HTMLVideoElement).poster || null,
          src: ((v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src || '').slice(0, 80),
          inDialog: !!v.closest('[role="dialog"], dialog'),
        };
      });
      // Is the caption/author text present at all?
      const loginWall = /log in|sign up|create new account/i.test(txt.slice(0, 400));
      return {
        vw, vh, url: location.href, title: document.title,
        bodyTextLen: txt.length, bodyTextHead: txt.slice(0, 300),
        loginWall,
        dialogCount: dialogs.length, dialogs,
        videoCount: videos.length, videos,
        articleCount: document.querySelectorAll('article').length,
        mainCount: document.querySelectorAll('main').length,
        canvasCount: document.querySelectorAll('canvas').length,
      };
    });
    report.push('\n── page shape ──', JSON.stringify(shape, null, 2));

    // ── Breakdown of what the "button" count actually counts ─────────────
    // buttonCount is `button, [role="button"]` — the same query the layout
    // finder and the modal detector use. On Instagram it reads as implausibly
    // high, so enumerate the real elements: tag, role, accessible name, size,
    // and whether they render any visible text.
    const buttons = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"], dialog');
      const scope: ParentNode = dlg ?? document;
      const els = Array.from(scope.querySelectorAll('button, [role="button"]'));
      const byKey = new Map<string, { n: number; sample: Record<string, unknown> }>();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') ?? '').trim();
        const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        const key = `${el.tagName.toLowerCase()}|role=${el.getAttribute('role') ?? '-'}|` +
          `label=${label || '(none)'}|text=${txt.slice(0, 24) || '(none)'}|vis=${visible}`;
        const cur = byKey.get(key);
        if (cur) cur.n++;
        else byKey.set(key, {
          n: 1,
          sample: {
            tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
            ariaLabel: label || null, text: txt.slice(0, 40) || null,
            w: Math.round(r.width), h: Math.round(r.height), visible,
            hasSvg: !!el.querySelector('svg'), hasImg: !!el.querySelector('img'),
          },
        });
      }
      const rows = [...byKey.values()].sort((a, b) => b.n - a.n);
      return {
        scopedToDialog: !!dlg,
        total: els.length,
        visible: els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length,
        realButtonTags: els.filter(e => e.tagName.toLowerCase() === 'button').length,
        roleButtonDivs: els.filter(e => e.tagName.toLowerCase() !== 'button').length,
        withVisibleText: els.filter(e => (e.textContent ?? '').trim().length > 0).length,
        groups: rows.slice(0, 25).map(r => ({ count: r.n, ...r.sample })),
      };
    });
    report.push('\n── button breakdown (inside dialog if present) ──', JSON.stringify(buttons, null, 2));

    // ── 3: what does the CURRENT pipeline capture today? ─────────────────
    // Production ships no broad host permission, so the content script is only
    // bound after the real activation gesture. Without this the capture bridge
    // has no listener and every run reports "capture timeout" — which is what
    // this probe did report until it was added.
    await activateExtensionOnTab(ctx, page.url());
    const cap = await page.evaluate(() => new Promise((res) => {
      const t = setTimeout(() => res({ error: 'capture timeout' }), 40_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); removeEventListener('message', on);
        res(e.data.error ? { error: e.data.error } : {
          title: e.data.capture?.title,
          bodyTextLen: (e.data.capture?.bodyText ?? '').length,
          bodyTextHead: (e.data.capture?.bodyText ?? '').slice(0, 400),
          bodyHtmlLen: (e.data.capture?.bodyHtml ?? '').length,
          imgs: (e.data.capture?.bodyHtml ?? '').match(/<img/g)?.length ?? 0,
        });
      };
      addEventListener('message', on);
      postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
    }));
    report.push('\n── current capture (article) ──', JSON.stringify(cap, null, 2));
  } catch (e) {
    report.push(`\nFAILED: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close();
  }
  const out = report.join('\n');
  writeFileSync(resolve(OUT, `instagram-probe-${tag}.txt`), out, 'utf8');
  // eslint-disable-next-line no-console
  console.log(out);
});
