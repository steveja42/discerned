// Visual smoke / investigation harness for goodreads.com book clips.
// Captures a real clip from goodreads.com via the extension, then renders it
// through the actual web app (/clips) and screenshots the rendered card so
// we can iterate on the (planned) tagGoodreads tagger and matching CSS.
//
// Run with: GOODREADS=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=goodreads-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';

const GOODREADS_URL =
  process.env.GOODREADS_URL ||
  'https://www.goodreads.com/book/show/58323771-friday';

test.describe.configure({ mode: 'serial' });

test('goodreads: capture clip, render in web app, screenshot card', async () => {
  test.skip(!process.env.GOODREADS, 'set GOODREADS=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension();
  try {
    // Goodreads 403s the default headless UA; spoof a real Chrome UA.
    await ctx.setExtraHTTPHeaders({
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Discerned')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, msg.text());
      }
    });
    await page.goto(GOODREADS_URL, { waitUntil: 'load', timeout: 60_000 });
    // Goodreads hydrates client-side; give it time to render and dismiss any cookie banner.
    await page.waitForTimeout(5_000);
    // Try to dismiss any modal/popup so we capture the actual page.
    await page.evaluate(() => {
      document.querySelectorAll('[aria-label*="Close" i], button[class*="close" i]').forEach((b) => {
        try { (b as HTMLElement).click(); } catch { /* ignore */ }
      });
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: out('goodreads-source.png'), fullPage: false });
    // Capture viewport-sized chunks of the page rather than one fullPage
    // screenshot — Goodreads is very tall and Chromium can fail capturing
    // it in one shot.
    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const viewportH = 720;
    const chunks: string[] = [];
    for (let y = 0; y < Math.min(totalHeight, 6000); y += viewportH) {
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
      await page.waitForTimeout(300);
      const name = `goodreads-source-${String(y).padStart(5, '0')}.png`;
      await page.screenshot({ path: out(name), fullPage: false });
      chunks.push(name);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    // Generic structural describer: print tag + a few stable attributes so we
    // can discover Goodreads's selectors (data-testid, itemprop, etc.).
    const dumpFrom = async (selector: string, label: string, maxDepth = 8) => {
      const struct = await page.evaluate(
        ({ selector, maxDepth }) => {
          const start = document.querySelector(selector);
          if (!start) return `(no match for ${selector})`;
          const describe = (el: Element, depth: number): string => {
            if (depth > maxDepth) return `${'  '.repeat(depth)}...`;
            const tag = el.tagName.toLowerCase();
            const attrs: string[] = [];
            for (const a of Array.from(el.attributes)) {
              if (
                a.name === 'data-testid' ||
                a.name === 'role' ||
                a.name === 'aria-label' ||
                a.name === 'itemprop' ||
                a.name === 'itemtype' ||
                a.name === 'class' ||
                a.name === 'href' ||
                a.name === 'src' ||
                a.name === 'alt'
              ) {
                attrs.push(`${a.name}="${a.value.slice(0, 90)}"`);
              }
            }
            const txt = (el.children.length === 0 ? (el.textContent ?? '').trim().slice(0, 60) : '');
            const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
            const txtStr = txt ? ` :: "${txt}"` : '';
            let s = `${'  '.repeat(depth)}<${tag}${attrStr}>${txtStr}`;
            for (const c of Array.from(el.children).slice(0, 12)) s += '\n' + describe(c, depth + 1);
            return s;
          };
          return describe(start, 0);
        },
        { selector, maxDepth },
      );
      fs.writeFileSync(out(label), struct, 'utf8');
    };

    // Enumerate testids present on the page.
    const testids = await page.evaluate(() => {
      const ids = new Map<string, number>();
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const id = el.getAttribute('data-testid') || '';
        const norm = id.replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, 'N');
        ids.set(norm, (ids.get(norm) ?? 0) + 1);
      });
      return Array.from(ids.entries()).sort((a, b) => b[1] - a[1]);
    });
    fs.writeFileSync(
      out('goodreads-testids.txt'),
      testids.map(([id, n]) => `${n}\t${id}`).join('\n'),
      'utf8',
    );

    // Dump structure around likely anchors.
    await dumpFrom('main', 'goodreads-main-structure.txt', 6);
    await dumpFrom('[data-testid="bookCover"]', 'goodreads-cover-structure.txt', 8);
    await dumpFrom('[data-testid="ratingsAndReviewsSection"]', 'goodreads-ratings-structure.txt', 8);
    await dumpFrom('.RatingStars', 'goodreads-stars-structure.txt', 6);
    await dumpFrom('.BookPageMetadataSection', 'goodreads-bookmeta-structure.txt', 8);
    await dumpFrom('.BookPageMetadataSection__genres', 'goodreads-genres-structure.txt', 6);
    await dumpFrom('.AuthorPreview', 'goodreads-author-structure.txt', 8);

    // Capture via the dev test bridge.
    const cap = (await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('capture timeout')), 60_000);
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.capture);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as Record<string, unknown>;

    // Render through the web app /clips.
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await libPage.evaluate((capture) => {
      const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, cap);

    const row = libPage.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();

    const clipBody = libPage.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
    await libPage.waitForTimeout(1000);

    await screenshotClipBody(libPage, clipBody, out('goodreads-rendered.png'));

    // Third artifact: the PUBLIC cast render (kind-30023 markdown), built by the
    // extension's real BUILD_CAST path from this same capture.
    await castShotSafe(page, cap as { title?: string }, out('goodreads-cast.png'));

    // Tight crop of the top of the rendered card (book hero area) so the
    // detail is legible — full clip body is way too tall to read.
    const bodyBox = await clipBody.boundingBox();
    if (bodyBox) {
      // Hero shot: roughly the top 800px at full width, large enough to read.
      await libPage.screenshot({
        path: out('goodreads-rendered-hero.png'),
        clip: {
          x: Math.max(0, bodyBox.x - 8),
          y: bodyBox.y,
          width: Math.min(bodyBox.width + 16, 900),
          height: Math.min(800, bodyBox.height),
        },
      });
      // Genres + stats: scroll a little further to see those.
      await libPage.screenshot({
        path: out('goodreads-rendered-mid.png'),
        clip: {
          x: Math.max(0, bodyBox.x - 8),
          y: bodyBox.y + 400,
          width: Math.min(bodyBox.width + 16, 900),
          height: Math.min(800, Math.max(100, bodyBox.height - 400)),
        },
      });
      // Author card region.
      await libPage.screenshot({
        path: out('goodreads-rendered-author.png'),
        clip: {
          x: Math.max(0, bodyBox.x - 8),
          y: bodyBox.y + 1000,
          width: Math.min(bodyBox.width + 16, 900),
          height: Math.min(700, Math.max(100, bodyBox.height - 1000)),
        },
      });
    }

    // Structural health checks (after screenshots so artifacts survive a fail).
    await assertClipBodyHealth(clipBody);

    // Image diagnostics: which images survived, their dimensions and context.
    const imgInfo = await clipBody.evaluate((root) => {
      return Array.from(root.querySelectorAll('img')).map((img) => {
        const r = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          srcStart: (img.getAttribute('src') || '').slice(0, 60),
          alt: (img.getAttribute('alt') || '').slice(0, 80),
          radius: cs.borderRadius,
          attrW: img.getAttribute('width'), attrH: img.getAttribute('height'),
          parentTag: img.parentElement?.tagName.toLowerCase() ?? '',
          parentClass: (img.parentElement?.getAttribute('class') || '').slice(0, 100),
        };
      });
    });
    fs.writeFileSync(out('goodreads-img-info.json'), JSON.stringify(imgInfo, null, 2), 'utf8');

    // SVG count on the rendered card — stars are usually SVG paths.
    const svgInfo = await clipBody.evaluate((root) => {
      const svgs = Array.from(root.querySelectorAll('svg'));
      return {
        count: svgs.length,
        sample: svgs.slice(0, 8).map((s) => {
          const r = s.getBoundingClientRect();
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            class: (s.getAttribute('class') || '').slice(0, 80),
            innerStart: s.innerHTML.slice(0, 120),
          };
        }),
      };
    });
    fs.writeFileSync(out('goodreads-svg-info.json'), JSON.stringify(svgInfo, null, 2), 'utf8');

    // Also dump the SVGs we *saw on the live page* — to compare what was captured vs. lost.
    const liveSvgInfo = await page.evaluate(() => {
      const svgs = Array.from(document.querySelectorAll('svg'));
      return {
        count: svgs.length,
        inRating: document.querySelectorAll('.RatingStars svg, [class*="RatingStars"] svg').length,
      };
    });
    fs.writeFileSync(out('goodreads-live-svg-info.json'), JSON.stringify(liveSvgInfo, null, 2), 'utf8');

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    fs.writeFileSync(out('goodreads-rendered.html'), html, 'utf8');
    fs.writeFileSync(out('goodreads-rendered-stripped.html'), stripped, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved goodreads-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
