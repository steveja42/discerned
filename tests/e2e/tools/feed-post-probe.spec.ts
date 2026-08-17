// Feasibility probe for "capture the FIRST VISIBLE post, not the whole feed".
//
// The defect: on feed pages (Instagram reels, the /reels player, Facebook video,
// any infinite-scroll feed) the layout finder returns the feed CONTAINER, so the
// clip carries every loaded post — including preloaded ones the user never saw.
// maybeExpandToFeed deliberately widens to the feed parent, which is right for a
// thread (primal/bsky) and wrong for an endless feed.
//
// Before writing pipeline code, this answers three questions on the REAL sites:
//   1. Are feed posts identifiable as repeated structural siblings?
//   2. Does "first post overlapping the viewport" pick the one the user sees?
//   3. Is that post self-contained (author + media + text inside it)?
//
// It reimplements nothing from the pipeline — it measures the DOM so the
// heuristic can be designed against evidence rather than intuition.
//
// Run (Chrome must be fully closed — warm profile lock):
//   FEEDP=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=feed-post-probe
// Options: FEEDP_ONLY=instagram-reels,reddit  FEEDP_HEADED=1  FEEDP_SCROLL=1

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');

// FEEDs (want: just the visible post) vs THREADs (want: the whole conversation,
// which maybeExpandToFeed correctly produces today). The thread entries are the
// regression risk — primal/bsky/HN are pixel-baselined on expanding behaviour —
// so any discriminator must classify these two groups differently.
const SITES: Record<string, string> = {
  // ── feeds ──
  'instagram-reels': 'https://www.instagram.com/reels/DbnxT2Duur8/',
  'instagram-profile-reels': 'https://www.instagram.com/hilaryagro/reels/',
  'instagram-home': 'https://www.instagram.com/',
  'facebook-feed': 'https://www.facebook.com/',
  'facebook-video': 'https://www.facebook.com/watch/',
  // The scrolling one-at-a-time video view — the Facebook shape closest to
  // Instagram reels (/watch/ is a GRID, which should not narrow).
  'facebook-reels': 'https://www.facebook.com/reel/',
  youtube: 'https://www.youtube.com/@Computerphile/videos',
  // ── threads (must NOT be treated as feeds) ──
  // Use pages that really are populated conversations — an empty/2-comment
  // thread has no repeating structure to measure.
  'hackernews-thread': 'https://news.ycombinator.com/item?id=45001234',
  // primal/bsky live views depend on a relay/API fetch that often never lands in
  // this environment (chrome renders, note never arrives → bodyText 0). The
  // COMMITTED fixtures are real snapshotted threads with the same DOM shape, so
  // they measure the thread layout deterministically. Served by the fixture
  // server the Playwright config already starts on :4173.
  'primal-thread-fixture': 'http://127.0.0.1:4173/primal-thread.html',
  'bsky-thread-fixture': 'http://127.0.0.1:4173/bsky-thread.html',
};

const TARGETS = (() => {
  const only = process.env.FEEDP_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  if (!only?.length) return SITES;
  return Object.fromEntries(Object.entries(SITES).filter(([k]) => only.includes(k)));
})();

test('feed-post-probe: can we isolate the first visible post?', async () => {
  test.skip(!process.env.FEEDP, 'set FEEDP=1 to run the feed-post probe');
  test.setTimeout(420_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome',
    preinstalledExtension: true,
    headed: !!process.env.FEEDP_HEADED,
  });
  const report: string[] = [`feed-post probe — ${new Date().toISOString()}`];
  try {
    for (const [name, url] of Object.entries(TARGETS)) {
      const page = await ctx.newPage();
      // Capture the pipeline's own decisions (which block the finder picked,
      // whether narrowing fired) — otherwise a non-firing heuristic is invisible.
      const pipelineLogs: string[] = [];
      page.on('console', m => {
        const t = m.text();
        if (/layout-finder picked|narrowed to visible feed post|expanded to feed parent|article captured via|hoist/i.test(t)) {
          pipelineLogs.push(t.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200));
        }
      });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForTimeout(9_000);
        // SPA thread views (primal fetches over a relay, bsky hydrates late) can
        // still be empty at 9s. Wait for real body text rather than guessing a
        // fixed delay — an empty page silently measures nothing.
        await page.waitForFunction(
          () => ((document.body?.innerText ?? '').trim().length > 400),
          undefined, { timeout: 45_000 },
        ).catch(() => undefined);
        await page.waitForTimeout(2_000);
        if (process.env.FEEDP_SCROLL) {
          // Scroll a little: the reported case is a feed the user has moved
          // through, where post #1 is no longer the visible one.
          await page.mouse.wheel(0, 900);
          await page.waitForTimeout(3_000);
        }
        await page.screenshot({ path: resolve(OUT, `feedpost-${name}.png`) });

        const info = await page.evaluate(() => {
          const vw = innerWidth, vh = innerHeight;
          const viewportArea = vw * vh;

          // ── 1. Find repeated structural siblings (the pipeline's own signal:
          // maybeExpandToFeed keys on tag|className among children of a parent).
          // Score every parent by how many same-signature children it has.
          type Group = { parent: Element; sig: string; items: Element[] };
          const groups: Group[] = [];
          const seen = new Set<Element>();
          for (const parent of Array.from(document.querySelectorAll('body *'))) {
            if (seen.has(parent)) continue;
            const kids = Array.from(parent.children);
            if (kids.length < 2) continue;
            const bySig = new Map<string, Element[]>();
            for (const k of kids) {
              const sig = `${k.tagName.toLowerCase()}|${typeof k.className === 'string' ? k.className.trim() : ''}`;
              const arr = bySig.get(sig) ?? [];
              arr.push(k);
              bySig.set(sig, arr);
            }
            for (const [sig, items] of bySig) {
              // A feed = 2+ siblings, each with real size and some content.
              if (items.length < 2) continue;
              // Width floor stays meaningful (a post spans the column), but the
              // HEIGHT floor must be small: Hacker News comments are <tr> rows
              // ~40px tall, and a 150px floor excluded every thread site.
              const sized = items.filter(i => {
                const r = i.getBoundingClientRect();
                return r.width > 150 && r.height > 30;
              });
              if (sized.length < 2) continue;
              const totalText = items.reduce((n, i) => n + (i.textContent ?? '').trim().length, 0);
              const totalMedia = items.reduce((n, i) => n + i.querySelectorAll('img, video').length, 0);
              if (totalText < 50 && totalMedia === 0) continue;
              groups.push({ parent, sig, items: sized });
              seen.add(parent);
            }
          }
          // Rank: most items, then largest combined area — the real feed track.
          groups.sort((a, b) => b.items.length - a.items.length);
          const top = groups.slice(0, 3).map(g => {
            const pr = g.parent.getBoundingClientRect();
            // ── 2. Which item is the FIRST VISIBLE one?
            const vis = g.items.map((it, idx) => {
              const r = it.getBoundingClientRect();
              const overlapY = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
              const overlapX = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
              const visArea = overlapX * overlapY;
              return {
                idx,
                top: Math.round(r.top), height: Math.round(r.height),
                visibleFraction: +(visArea / Math.max(r.width * r.height, 1)).toFixed(2),
                viewportShare: +(visArea / viewportArea).toFixed(2),
                textLen: (it.textContent ?? '').replace(/\s+/g, ' ').trim().length,
                imgs: it.querySelectorAll('img').length,
                videos: it.querySelectorAll('video').length,
                // ── 3. Self-contained? Does the item carry its own author/meta?
                links: it.querySelectorAll('a[href]').length,
                headings: it.querySelectorAll('h1,h2,h3,[role="heading"]').length,
                textHead: (it.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70),
              };
            });
            const firstVisible = vis.find(v => v.visibleFraction > 0.5)
              ?? vis.find(v => v.visibleFraction > 0) ?? null;
            // The one occupying the most viewport — the "dominant" post.
            const dominant = [...vis].sort((a, b) => b.viewportShare - a.viewportShare)[0] ?? null;

            // ── Candidate UNBOUNDED-FEED signals ───────────────────────────
            // Viewport dominance separates reels (0.99) from threads (0.22-0.33)
            // but NOT the home feeds (instagram 0.28 / facebook 0.19) — those sit
            // inside the thread band. Hypothesis: a FEED is an unbounded list of
            // SELF-CONTAINED items; a THREAD is a finite set of replies. Measure
            // the signals that would express that, so the rule is chosen from
            // data rather than intuition.
            const selfContained = g.items.filter(i =>
              i.tagName.toLowerCase() === 'article' || i.getAttribute('role') === 'article'
              || i.querySelector(':scope > article, :scope > [role="article"]') !== null).length;
            // Virtualisation / infinite-scroll machinery near the track.
            const parentHtml = g.parent;
            const loaderish = parentHtml.querySelectorAll(
              '[role="progressbar"], [aria-busy="true"], [data-visualcompletion="loading-state"], ' +
              '[class*="loader" i], [class*="spinner" i], [class*="sentinel" i]').length;
            // Does each item carry its own author/byline+timestamp? A feed item is
            // a standalone post; a thread reply usually is too, so this is
            // descriptive rather than decisive — recorded for comparison.
            const withTime = g.items.filter(i => i.querySelector('time') !== null).length;
            const withLinkAuthor = g.items.filter(i => i.querySelector('a[href*="/"]') !== null).length;
            const feedSignals = {
              selfContainedItems: selfContained,
              selfContainedRatio: +(selfContained / g.items.length).toFixed(2),
              loaderish,
              withTime, withLinkAuthor,
              parentScrollHeight: Math.round((parentHtml as HTMLElement).scrollHeight ?? 0),
              parentClientHeight: Math.round((parentHtml as HTMLElement).clientHeight ?? 0),
            };

            // ── Candidate FEED-vs-THREAD discriminators ────────────────────
            // A FEED is consumed one item at a time: one sibling dominates the
            // viewport and the others are scrolled away. A THREAD is read as a
            // whole: several siblings are on screen together and each is short.
            const partiallyVisible = vis.filter(v => v.visibleFraction > 0.05).length;
            const topShare = dominant?.viewportShare ?? 0;
            const sumVisibleShare = +vis.reduce((n, v) => n + v.viewportShare, 0).toFixed(2);
            // How much taller than the viewport is a typical item?
            const heights = vis.map(v => v.height).filter(h => h > 0).sort((a, b) => a - b);
            const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
            return {
              sig: g.sig.slice(0, 60),
              itemCount: g.items.length,
              parentTag: g.parent.tagName.toLowerCase(),
              parentSize: `${Math.round(pr.width)}x${Math.round(pr.height)}`,
              firstVisible, dominant,
              agree: firstVisible && dominant ? firstVisible.idx === dominant.idx : null,
              discriminators: {
                partiallyVisible,          // FEED ≈ 1, THREAD ≥ 2
                topShare,                  // FEED: one item owns the viewport
                sumVisibleShare,           // total on-screen area of all items
                medianHeight,              // FEED: ≈ viewport height or taller
                medianHeightVsViewport: +(medianHeight / vh).toFixed(2),
              },
              feedSignals,
              items: vis.slice(0, 6),
            };
          });
          return {
            url: location.href, vw, vh,
            bodyTextLen: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
            groupCount: groups.length,
            topGroups: top,
          };
        });
        report.push(`\n===== ${name} =====`, JSON.stringify(info, null, 2));

        // ── UNBOUNDEDNESS: does the track GROW when you scroll to its end? ──
        // The direct test of "feed vs thread": an infinite feed appends more
        // items on scroll; a thread's reply set is fixed. Measured on the same
        // top group, before/after scrolling to the bottom.
        const growth = await page.evaluate(async () => {
          const vw = innerWidth, vh = innerHeight;
          // Re-find the top group the same way the report above did.
          let best: { parent: Element; items: Element[] } | null = null;
          for (const parent of Array.from(document.querySelectorAll('body *'))) {
            const bySig = new Map<string, Element[]>();
            for (const k of Array.from(parent.children)) {
              const sig = `${k.tagName.toLowerCase()}|${typeof k.className === 'string' ? k.className.trim() : ''}`;
              const arr = bySig.get(sig) ?? []; arr.push(k); bySig.set(sig, arr);
            }
            for (const items of bySig.values()) {
              const sized = items.filter(i => {
                const r = i.getBoundingClientRect();
                return r.width > 150 && r.height > 30;
              });
              if (sized.length >= 2 && (!best || sized.length > best.items.length)) {
                best = { parent, items: sized };
              }
            }
          }
          if (!best) return { error: 'no group' };
          const sigOf = (e: Element) => `${e.tagName.toLowerCase()}|${typeof e.className === 'string' ? e.className.trim() : ''}`;
          const sig = sigOf(best.items[0]);
          const countNow = () => Array.from(best!.parent.children).filter(c => sigOf(c) === sig).length;
          const before = countNow();
          const heightBefore = (best.parent as HTMLElement).scrollHeight;
          // Scroll several viewports down and wait for lazy appends.
          for (let i = 0; i < 4; i++) {
            window.scrollBy(0, vh);
            await new Promise(r => setTimeout(r, 1200));
          }
          await new Promise(r => setTimeout(r, 2000));
          const after = countNow();
          const heightAfter = (best.parent as HTMLElement).scrollHeight;
          window.scrollTo(0, 0);
          return {
            itemsBefore: before, itemsAfter: after, grew: after > before,
            heightBefore, heightAfter, heightGrew: heightAfter > heightBefore,
            vw, vh,
          };
        }).catch(e => ({ error: String(e).slice(0, 80) }));
        report.push(`-- unbounded: ${JSON.stringify(growth)}`);
        await page.waitForTimeout(1500);

        // Run the REAL pipeline and compare the captured text against the whole
        // page. A feed that narrowed correctly captures a small fraction; an
        // un-narrowed feed lands at ~100% (or more, with preloaded posts).
        const cap = await page.evaluate(() => new Promise((res) => {
          const t = setTimeout(() => res({ error: 'capture timeout' }), 40_000);
          const on = (e: MessageEvent) => {
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(t); removeEventListener('message', on);
            const c = e.data.capture;
            res(e.data.error ? { error: e.data.error } : {
              bodyTextLen: (c?.bodyText ?? '').length,
              bodyTextHead: (c?.bodyText ?? '').slice(0, 160),
              imgs: (c?.bodyHtml ?? '').match(/<img/g)?.length ?? 0,
              videos: (c?.bodyHtml ?? '').match(/<video/g)?.length ?? 0,
            });
          };
          addEventListener('message', on);
          postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
        })) as Record<string, number | string>;
        const pct = typeof cap.bodyTextLen === 'number' && info.bodyTextLen
          ? ((cap.bodyTextLen / info.bodyTextLen) * 100).toFixed(0) + '% of page text'
          : 'n/a';
        report.push(`-- capture: ${JSON.stringify(cap)}\n-- coverage: ${pct}`);
        report.push(`-- pipeline: ${pipelineLogs.length ? pipelineLogs.join(' | ') : '(no finder/narrow logs)'}`);
      } catch (e) {
        report.push(`\n===== ${name} =====\nFAILED: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await ctx.close();
  }
  const out = report.join('\n');
  writeFileSync(resolve(OUT, 'feed-post-probe.txt'), out, 'utf8');
  // eslint-disable-next-line no-console
  console.log(out);
});
