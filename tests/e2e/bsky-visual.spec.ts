// Visual smoke / investigation harness for bsky.app post clips.
// Captures a real clip from bsky.app via the extension, then renders it
// through the actual web app (/clips) and screenshots the rendered card so
// we can compare against the source page and iterate on the tagBsky tagger.
//
// Run with: BSKY=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts tests/e2e/bsky-visual.spec.ts

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';

const BSKY_URL =
  process.env.BSKY_URL ||
  'https://bsky.app/profile/donaldjtrump-maga.bsky.social';

test.describe.configure({ mode: 'serial' });

test('bsky: capture clip, render in web app, screenshot card', async () => {
  test.skip(!process.env.BSKY, 'set BSKY=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Discerned')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, msg.text());
      }
    });
    await page.goto(BSKY_URL, { waitUntil: 'load', timeout: 60_000 });
    // Bluesky hydrates client-side; give the feed/thread time to render.
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: out('bsky-source.png'), fullPage: false });

    // Generic structural describer: print tag + a few stable attributes so we
    // can discover Bluesky's selectors (data-testid, role, aria-label).
    const dumpFrom = async (selector: string, label: string, maxDepth = 7) => {
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
                a.name === 'href' ||
                a.name === 'dir'
              ) {
                attrs.push(`${a.name}="${a.value.slice(0, 70)}"`);
              }
            }
            const txt = (el.children.length === 0 ? (el.textContent ?? '').trim().slice(0, 40) : '');
            const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
            const txtStr = txt ? ` :: "${txt}"` : '';
            let s = `${'  '.repeat(depth)}<${tag}${attrStr}>${txtStr}`;
            for (const c of Array.from(el.children).slice(0, 10)) s += '\n' + describe(c, depth + 1);
            return s;
          };
          return describe(start, 0);
        },
        { selector, maxDepth },
      );
      fs.writeFileSync(out(label), struct, 'utf8');
    };

    // Enumerate the testids present on the page so we know what anchors exist.
    const testids = await page.evaluate(() => {
      const ids = new Map<string, number>();
      document.querySelectorAll('[data-testid]').forEach((el) => {
        const id = el.getAttribute('data-testid') || '';
        // Collapse numeric/hash suffixes so we see the pattern, not 200 rows.
        const norm = id.replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, 'N');
        ids.set(norm, (ids.get(norm) ?? 0) + 1);
      });
      return Array.from(ids.entries()).sort((a, b) => b[1] - a[1]);
    });
    fs.writeFileSync(
      out('bsky-testids.txt'),
      testids.map(([id, n]) => `${n}\t${id}`).join('\n'),
      'utf8',
    );

    // Dump structure around likely anchors. These are best-guesses; whichever
    // matches will produce a file, the rest log "(no match)".
    await dumpFrom('[data-testid^="postThreadItem"]', 'bsky-thread-structure.txt', 8);
    await dumpFrom('[data-testid^="feedItem"]', 'bsky-feeditem-structure.txt', 8);
    await dumpFrom('[role="link"][aria-label*="Post by"]', 'bsky-postlink-structure.txt', 8);
    await dumpFrom('[data-testid="contentHider-post"]', 'bsky-contenthider-structure.txt', 8);
    // Second thread item = first reply (different header layout than main post).
    await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="postThreadItem-by-"]');
      if (items[1]) items[1].setAttribute('data-dx-probe', 'reply');
    });
    await dumpFrom('[data-dx-probe="reply"]', 'bsky-reply-structure.txt', 8);

    // Capture via the dev test bridge.
    const cap = (await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('capture timeout')), 30_000);
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

    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.setViewportSize({ width: 1280, height: Math.ceil(rect.height) + 100 });
      await libPage.waitForTimeout(500);
    }
    await clipBody.screenshot({ path: out('bsky-rendered.png') });
    // Tight crop of the first few posts so the detail is legible: screenshot
    // just the first three dx-post elements stacked.
    const postCount = await libPage.locator('.clip-body .dx-post').count();
    const cropIdx = Math.min(2, Math.max(0, postCount - 1));
    const firstPosts = libPage.locator('.clip-body .dx-post').nth(cropIdx);
    const box3 = postCount > 0 ? await firstPosts.boundingBox() : null;
    const bodyBox = await clipBody.boundingBox();
    if (box3 && bodyBox) {
      await libPage.screenshot({
        path: out('bsky-rendered-top.png'),
        clip: { x: bodyBox.x, y: bodyBox.y, width: Math.min(bodyBox.width, 700), height: Math.min((box3.y + box3.height) - bodyBox.y, 3000) },
      });
    }

    const imgInfo = await clipBody.evaluate((root) => {
      return Array.from(root.querySelectorAll('img')).map((img) => {
        const r = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          radius: cs.borderRadius, objectFit: cs.objectFit,
          inHeader: !!img.closest('.dx-header'),
          attrW: img.getAttribute('width'), attrH: img.getAttribute('height'),
        };
      }).filter((i) => i.w > 40 && (i.radius.includes('50%') || i.h > 120)).slice(0, 25);
    });
    fs.writeFileSync(out('bsky-img-info.json'), JSON.stringify(imgInfo, null, 2), 'utf8');

    // Optional: screenshot a region around a text match (set BSKY_FIND).
    const find = process.env.BSKY_FIND;
    if (find) {
      const region = await clipBody.evaluate((root, needle) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if ((n.textContent ?? '').includes(needle)) {
            const post = (n.parentElement as Element)?.closest('.dx-post');
            if (post) { const r = post.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
          }
        }
        return null;
      }, find);
      if (region) {
        await libPage.screenshot({
          path: out('bsky-rendered-find.png'),
          clip: { x: region.x, y: region.y, width: Math.min(region.w, 700), height: Math.min(region.h, 1200) },
        });
      }
    }

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    fs.writeFileSync(out('bsky-rendered.html'), html, 'utf8');
    fs.writeFileSync(out('bsky-rendered-stripped.html'), stripped, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved bsky-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
