// Visual-parity check for Reddit comment threads.
// Run: $env:REDDIT='1'; pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=reddit-visual

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const RD_URL =
  process.env.REDDIT_URL ||
  // r/mildlyinfuriating thread reported by user with avatar misalignment + triple image.
  'https://www.reddit.com/r/mildlyinfuriating/comments/1tw7cla/this_car_ive_never_seen_before_has_been_parked_in/';

test.describe.configure({ mode: 'serial' });

test('reddit-visual: capture post + comments, render in /clips, screenshot', async () => {
  test.skip(!process.env.REDDIT, 'set REDDIT=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const profile = process.env.PROFILE ?? 'test';
  const headed = process.env.PWDEBUG_HEADED === '0' ? false : true;
  const { ctx } = await launchWithExtension({ profile, headed });
  try {
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Discerned') || t.includes('dx-')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, t);
      }
    });
    await page.goto(RD_URL, { waitUntil: 'load', timeout: 60_000 });
    // New Reddit uses custom elements; wait for the main post.
    await page.waitForSelector('shreddit-post, [data-test-id="post-content"], article', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: out('reddit-source.png'), fullPage: false });

    const struct = await page.evaluate(() => {
      const lines: string[] = [];
      const sels = ['shreddit-post', 'shreddit-comment-tree', 'shreddit-comment', '[slot="title"]', '[slot="text-body"]', '[slot="credit-bar"]', '[slot="post-footer"]', '[slot="commentMeta"]', '[data-testid="comment"]', 'article', 'main', '#main-content'];
      sels.forEach((s) => {
        const all = document.querySelectorAll(s);
        if (all.length === 0) { lines.push(`${s} → 0`); return; }
        const r = (all[0] as HTMLElement).getBoundingClientRect();
        lines.push(`${s} → count=${all.length} first <${all[0].tagName.toLowerCase()}> x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
      });
      const shadowCount = (() => {
        let n = 0;
        document.querySelectorAll('*').forEach((el) => { if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) n++; });
        return n;
      })();
      lines.push(`shadow_root_count=${shadowCount}`);

      // Slot inventory inside shreddit-post (light-DOM children with slot=)
      const post = document.querySelector('shreddit-post');
      if (post) {
        lines.push(`\n=== shreddit-post slot inventory ===`);
        Array.from(post.querySelectorAll('[slot]')).slice(0, 30).forEach(el => {
          lines.push(`  slot="${el.getAttribute('slot')}" <${el.tagName.toLowerCase()}> children=${el.children.length} text="${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"`);
        });
        lines.push(`shreddit-post attrs: ${Array.from(post.attributes).map(a => `${a.name}="${a.value.slice(0, 50)}"`).join(' ')}`);
      }

      // First comment dump
      const cmt = document.querySelector('shreddit-comment');
      if (cmt) {
        lines.push(`\n=== first shreddit-comment ===`);
        lines.push(`attrs: ${Array.from(cmt.attributes).map(a => `${a.name}="${a.value.slice(0, 40)}"`).join(' ')}`);
        Array.from(cmt.querySelectorAll('[slot]')).slice(0, 20).forEach(el => {
          lines.push(`  slot="${el.getAttribute('slot')}" <${el.tagName.toLowerCase()}> text="${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"`);
        });
      }

      // Dump back-arrow chrome structure. Pierce shadow roots too.
      const allEls: Element[] = [];
      const walk = (root: ParentNode) => {
        root.querySelectorAll('*').forEach(el => {
          allEls.push(el);
          const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) walk(sr);
        });
      };
      walk(document.querySelector('main') ?? document.body);
      const backCandidates = allEls.filter(el => {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        return /^back$/i.test(t) && el.querySelector('svg');
      });
      lines.push(`\n=== back-arrow candidates (incl shadow): ${backCandidates.length} ===`);
      backCandidates.slice(0, 5).forEach((el, i) => {
        const rootName = el.getRootNode() === document ? 'light' : `shadow-of-${(el.getRootNode() as ShadowRoot).host?.tagName.toLowerCase()}`;
        lines.push(`#${i} [${rootName}]: <${el.tagName.toLowerCase()}> attrs: ${Array.from(el.attributes).map(a => `${a.name}="${a.value.slice(0, 40)}"`).join(' ')}`);
      });

      // Look at direct children of main.
      const mainEl = document.querySelector('main');
      if (mainEl) {
        lines.push(`\n=== <main> direct children ===`);
        Array.from(mainEl.children).slice(0, 10).forEach((c, i) => {
          const txt = (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
          lines.push(`#${i} <${c.tagName.toLowerCase()}> text="${txt}"`);
        });
      }

      // Dump image structure inside post-media slot to understand the triple-img.
      const postMedia = document.querySelector('shreddit-post [slot="post-media-container"], shreddit-post post-media-image, shreddit-post shreddit-aspect-ratio, shreddit-post picture');
      if (postMedia) {
        lines.push(`\n=== post-media region (${postMedia.tagName.toLowerCase()}) ===`);
        const describe = (el: Element, depth: number, max: number): string => {
          if (depth > max) return `${'  '.repeat(depth)}…`;
          const tag = el.tagName.toLowerCase();
          const attrs = ['src', 'srcset', 'alt', 'class', 'data-testid', 'aria-hidden', 'style', 'width', 'height']
            .filter(a => el.hasAttribute(a))
            .map(a => `${a}="${(el.getAttribute(a) ?? '').slice(0, 60)}"`)
            .join(' ');
          let s = `${'  '.repeat(depth)}<${tag}${attrs ? ' ' + attrs : ''}>`;
          Array.from(el.children).slice(0, 8).forEach(c => { s += '\n' + describe(c, depth + 1, max); });
          return s;
        };
        lines.push(describe(postMedia, 0, 5));
      }
      return lines.join('\n');
    });
    writeFileSync(out('reddit-structure.txt'), struct, 'utf8');

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

    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
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
    await libPage.waitForTimeout(1000);

    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.setViewportSize({ width: 1280, height: Math.min(Math.ceil(rect.height) + 100, 8000) });
      await libPage.waitForTimeout(500);
    }
    await clipBody.screenshot({ path: out('reddit-rendered.png') });

    // Tight top-of-clip crop so byline + first image are legible without
    // downscaling the whole thread. Captures the first ~600px below the
    // clipBody's top edge.
    const bodyBox = await clipBody.boundingBox();
    if (bodyBox) {
      await libPage.screenshot({
        path: out('reddit-rendered-top.png'),
        clip: { x: bodyBox.x, y: bodyBox.y, width: Math.min(bodyBox.width, 800), height: 700 },
      });
    }

    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    writeFileSync(out('reddit-rendered.html'), html, 'utf8');
    writeFileSync(out('reddit-rendered-stripped.html'), stripped, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved reddit-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
