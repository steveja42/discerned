// One-shot probe: opens a real article with embedded tweets, finds the
// platform.twitter.com embed iframes, and dumps their DOM structure so the
// embedded-tweet extractor's selectors can be authored against the real shape.
//
// Run with: PROBE=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//   tests/e2e/embedded-tweet-probe.spec.ts
//
// All output lands in <repo>/test-output/embed-* (gitignored).

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_WITH_EMBEDS =
  process.env.EMBED_URL ||
  'https://www.zerohedge.com/geopolitical/brief-exchange-top-us-cuban-military-leaders-meet-edge-guantanamo-base';

test('probe: dump platform.twitter.com embed iframe DOM structure', async () => {
  test.skip(!process.env.PROBE, 'set PROBE=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  // No extension needed — we just need to inspect the embed iframe DOM.
  const userDataDir = mkdtempSync(join(tmpdir(), 'discerned-probe-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--headless=new', '--no-sandbox', '--no-first-run'],
    viewport: { width: 1280, height: 2400 },
  });

  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      // eslint-disable-next-line no-console
      if (msg.type() === 'error') console.log(`[browser:error] ${msg.text()}`);
    });
    await page.goto(URL_WITH_EMBEDS, { waitUntil: 'load', timeout: 60_000 });

    // Wait for widgets.js to render. The iframes appear lazily as the user
    // scrolls; scroll to bottom to force all embeds to render.
    await page.evaluate(async () => {
      await new Promise<void>((resolveScroll) => {
        let y = 0;
        const step = () => {
          window.scrollTo(0, y);
          y += 400;
          if (y < document.body.scrollHeight + 800) setTimeout(step, 150);
          else { window.scrollTo(0, 0); setTimeout(() => resolveScroll(), 500); }
        };
        step();
      });
    });
    await page.waitForTimeout(6_000);

    // Enumerate child frames whose URL is the X embed page.
    const allFrames = page.frames();
    const tweetFrames = allFrames.filter(f =>
      /^https:\/\/platform\.twitter\.com\/embed\/Tweet\.html/i.test(f.url())
    );

    let report = `Probe URL: ${URL_WITH_EMBEDS}\n`;
    report += `Total frames on page: ${allFrames.length}\n`;
    report += `Twitter embed frames: ${tweetFrames.length}\n`;
    report += `\n${'='.repeat(80)}\n`;

    if (tweetFrames.length === 0) {
      report += 'NO TWEET EMBED FRAMES FOUND. The widgets.js script may not have rendered yet.\n';
      report += 'All frame URLs:\n';
      allFrames.forEach((f, i) => { report += `  [${i}] ${f.url()}\n`; });
    }

    for (let i = 0; i < tweetFrames.length; i++) {
      const frame = tweetFrames[i];
      report += `\nFRAME [${i}]: ${frame.url().slice(0, 200)}\n`;
      report += `${'-'.repeat(80)}\n`;

      // 1. List all testIds in the embed iframe DOM.
      try {
        const testIds = await frame.evaluate(() => {
          const ids = new Set<string>();
          document.querySelectorAll('[data-testid]').forEach(el => {
            const id = el.getAttribute('data-testid');
            if (id) ids.add(id);
          });
          return Array.from(ids).sort();
        });
        report += `\nAll data-testid values found (${testIds.length}):\n`;
        testIds.forEach(id => { report += `  ${id}\n`; });
      } catch (err) {
        report += `\n(could not enumerate testIds: ${err})\n`;
      }

      // 2-pre. Inspect the photo container's layout — we want to know what
      // grid X actually uses for N-photo tweets so we can mimic it.
      try {
        const photoLayout = await frame.evaluate(() => {
          const photoLinks = Array.from(document.querySelectorAll('a[href*="/photo/"]'));
          if (photoLinks.length === 0) return null;
          // Find smallest common ancestor of all photo links.
          let common: Element | null = photoLinks[0] as Element;
          for (const link of photoLinks.slice(1)) {
            while (common && !common.contains(link as Element)) common = common.parentElement;
            if (!common) break;
          }
          if (!common) return null;
          const describe = (el: Element, depth: number, max: number): string => {
            if (depth > max) return `${'  '.repeat(depth)}...`;
            const tag = el.tagName.toLowerCase();
            const cs = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const layout = [
              `disp=${cs.display}`,
              cs.flexDirection !== 'row' ? `flexDir=${cs.flexDirection}` : '',
              cs.gridTemplateColumns !== 'none' ? `gridCols=${cs.gridTemplateColumns}` : '',
              `wh=${Math.round(rect.width)}x${Math.round(rect.height)}`,
            ].filter(Boolean).join(' ');
            let s = `${'  '.repeat(depth)}<${tag} ${layout}>`;
            for (const c of Array.from(el.children).slice(0, 10)) s += '\n' + describe(c, depth + 1, max);
            return s;
          };
          return `Photo count: ${photoLinks.length}\nCommon ancestor layout:\n${describe(common, 0, 7)}`;
        });
        if (photoLayout) {
          writeFileSync(out(`embed-frame-${i}-photolayout.txt`), photoLayout, 'utf8');
          report += `\nPhoto layout → embed-frame-${i}-photolayout.txt\n`;
        }
      } catch (err) {
        report += `\n(photo layout dump failed: ${err})\n`;
      }

      // 2a. Compute what our extractor would produce for this frame, end-to-end.
      try {
        const extracted = await frame.evaluate(() => {
          const article = document.querySelector('article');
          if (!article) return { error: 'no article' };
          const avatarContainer = article.querySelector('[data-testid^="UserAvatar-Container-"]');
          const handle = avatarContainer?.getAttribute('data-testid')?.replace(/^UserAvatar-Container-/, '') ?? '';
          const avatarImg = avatarContainer?.querySelector('img');
          const profileLinks = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="twitter.com/"], a[href*="x.com/"]'))
            .filter(a => !/\/status\//.test(a.getAttribute('href') ?? ''))
            .filter(a => !/\/hashtag\//.test(a.getAttribute('href') ?? ''));
          const displayName = profileLinks.map(a => (a.textContent ?? '').trim()).find(t => t.length > 0) ?? '';
          const tweetText = article.querySelector('[data-testid="tweetText"]');
          const tweetTextHtml = tweetText ? tweetText.innerHTML : '';
          const statusAnchor = article.querySelector<HTMLAnchorElement>('a[aria-label="Visit this post on X"]');
          const statusUrl = statusAnchor?.getAttribute('href')?.split('?')[0] ?? '';
          const tweetId = (statusUrl.match(/\/status\/(\d+)/) ?? [])[1] ?? '';
          const time = article.querySelector('time[datetime]');
          const dateText = time?.textContent?.trim() ?? '';
          const datetimeIso = time?.getAttribute('datetime') ?? '';
          const photos = Array.from(article.querySelectorAll<HTMLImageElement>('a[href*="/photo/"] img'))
            .map(img => img.src);
          const isVerified = !!article.querySelector('[data-testid="icon-verified"]');
          return { handle, displayName, avatarSrc: avatarImg?.src ?? '', tweetTextHtml: tweetTextHtml.slice(0, 200), statusUrl, tweetId, dateText, datetimeIso, photos, isVerified };
        });
        report += `\nExtractor preview:\n  ${JSON.stringify(extracted, null, 2).split('\n').join('\n  ')}\n`;
      } catch (err) {
        report += `\n(extractor preview failed: ${err})\n`;
      }

      // 2. Probe specific candidate selectors. For each: present? count? sample inner text/src?
      const probes: Array<[string, string]> = [
        ['article', 'article'],
        ['[data-testid^="UserAvatar-Container-"]', 'UserAvatar-Container'],
        ['[data-testid^="UserAvatar-Container-"] img', 'UserAvatar img'],
        ['[data-testid="tweetText"]', 'tweetText'],
        ['[data-testid="icon-verified"]', 'icon-verified'],
        ['[data-testid="tweet-text-show-more-link"]', 'show-more'],
        ['time[datetime]', 'time-datetime'],
        ['a[aria-label="Visit this post on X"]', 'visit-on-x'],
        ['a[href*="/photo/"]', 'photo-link'],
        ['a[href*="/photo/"] img', 'photo-img'],
        ['a[href*="/video/"]', 'video-link'],
        ['video', 'video-tag'],
        ['video[poster]', 'video-poster'],
        ['img[src*="pbs.twimg.com/media"]', 'twimg-media'],
        ['img[src*="pbs.twimg.com/amplify_video_thumb"]', 'video-thumb'],
        ['img[src*="pbs.twimg.com/profile_images"]', 'profile-img'],
        ['[role="img"]', 'role-img-bg'],
      ];
      report += `\nSelector probes:\n`;
      for (const [sel, label] of probes) {
        try {
          const result = await frame.evaluate((s) => {
            const els = document.querySelectorAll(s);
            if (els.length === 0) return null;
            const first = els[0] as HTMLElement;
            return {
              count: els.length,
              tag: first.tagName.toLowerCase(),
              text: (first.textContent ?? '').slice(0, 80).replace(/\s+/g, ' ').trim(),
              attrs: Array.from(first.attributes)
                .slice(0, 6)
                .map(a => `${a.name}="${a.value.slice(0, 60)}"`)
                .join(' '),
            };
          }, sel);
          if (result === null) {
            report += `  [MISS] ${label.padEnd(24)} ${sel}\n`;
          } else {
            report += `  [HIT ${String(result.count).padStart(3)}] ${label.padEnd(24)} <${result.tag}> "${result.text}" | ${result.attrs}\n`;
          }
        } catch (err) {
          report += `  [ERR ] ${label.padEnd(24)} ${sel} — ${err}\n`;
        }
      }

      // 3. Dump a compact tree of the iframe's body (tags + key attrs only,
      //    capped at depth 8 and 200 children per node).
      try {
        const tree = await frame.evaluate(() => {
          const describe = (el: Element, depth: number, maxDepth: number): string => {
            if (depth > maxDepth) return `${'  '.repeat(depth)}...`;
            const tag = el.tagName.toLowerCase();
            const attrs: string[] = [];
            for (const a of Array.from(el.attributes)) {
              if (a.name === 'data-testid' || a.name === 'role' || a.name === 'aria-label'
                  || a.name === 'href' || a.name === 'datetime' || a.name === 'poster' || a.name === 'alt'
                  || a.name === 'id' || (a.name === 'src' && (tag === 'img' || tag === 'video'))) {
                attrs.push(`${a.name}="${a.value.slice(0, 80)}"`);
              }
            }
            const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
            const text = (el.children.length === 0 && el.textContent)
              ? ` "${el.textContent.slice(0, 60).replace(/\s+/g, ' ').trim()}"`
              : '';
            let s = `${'  '.repeat(depth)}<${tag}${attrStr}>${text}`;
            for (const c of Array.from(el.children).slice(0, 200)) {
              s += '\n' + describe(c, depth + 1, maxDepth);
            }
            return s;
          };
          return describe(document.body, 0, 14);
        });
        writeFileSync(out(`embed-frame-${i}-tree.txt`), tree, 'utf8');
        report += `\nFull tree → embed-frame-${i}-tree.txt (${tree.length} chars)\n`;
      } catch (err) {
        report += `\n(could not dump tree: ${err})\n`;
      }

      // 3b. Dump article.innerHTML (raw, capped) so we can see the author header
      //     structure (display name, badges, handle, follow button).
      try {
        const articleHtml = await frame.evaluate(() => {
          const a = document.querySelector('article');
          return a ? a.innerHTML : '(no article)';
        });
        writeFileSync(out(`embed-frame-${i}-article.html`), articleHtml.slice(0, 20000), 'utf8');
        report += `Article innerHTML → embed-frame-${i}-article.html (${articleHtml.length} chars total, first 20k saved)\n`;
      } catch { /* best effort */ }

      // 4. Also screenshot the iframe so we know what we're looking at.
      try {
        const iframeEl = await page.$(`iframe[src="${frame.url()}"]`);
        if (iframeEl) {
          await iframeEl.screenshot({ path: out(`embed-frame-${i}-screenshot.png`) });
          report += `Screenshot → embed-frame-${i}-screenshot.png\n`;
        }
      } catch { /* best effort */ }
    }

    writeFileSync(out('embed-probe-report.txt'), report, 'utf8');
    // eslint-disable-next-line no-console
    console.log('\n' + report);
  } finally {
    await ctx.close();
  }
});
