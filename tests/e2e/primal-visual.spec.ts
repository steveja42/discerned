// Visual smoke test for the primal.net article clip.
// Captures a real clip from primal.net via the extension, then renders it
// through the actual web app (/clips) and screenshots the rendered card so
// we can compare against the source page.
//
// Run with: PRIMAL=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts tests/e2e/primal-visual.spec.ts

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';
import { assertClipBodyHealth } from './helpers/clipBodyHealth';
import { screenshotClipBody } from './helpers/clipShot';
import { castShotSafe } from './helpers/castShot';

const PRIMAL_URL =
  process.env.PRIMAL_URL ||
  'https://primal.net/e/nevent1qqs23jpquykrlg2psqhyhhxzn06nmf3dr6yejwvgws0733x8d9vgnugqfuqeq';

test.describe.configure({ mode: 'serial' });

test('primal: capture clip, render in web app, screenshot card', async () => {
  test.skip(!process.env.PRIMAL, 'set PRIMAL=1 to run this');
  test.setTimeout(120_000);

  // All visual debug artifacts land in <repo>/test-output/ (gitignored).
  const outDir = resolve(__dirname, '..', '..', 'test-output');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = (name: string) => resolve(outDir, name);

  const { ctx } = await launchWithExtension();
  try {
    // 1. Open primal.net and capture the article clip via the dev test bridge.
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Discerned')) {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}]`, msg.text());
      }
    });
    await page.goto(PRIMAL_URL, { waitUntil: 'load', timeout: 45_000 });
    // Primal hydrates client-side; give it a moment for the note to render.
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: out('primal-source.png'), fullPage: false });

    // Dump the primary note container's outerHTML (with attribute names visible)
    // so we can see primal's stable selectors. Strip inner text and images.
    const liveStructure = await page.evaluate(() => {
      const primary = document.querySelector('[data-event-bech32]');
      if (!primary) return '(no [data-event-bech32] found)';
      const describe = (el: Element, depth: number): string => {
        if (depth > 5) return `${'  '.repeat(depth)}...`;
        const tag = el.tagName.toLowerCase();
        const attrs: string[] = [];
        for (const a of Array.from(el.attributes)) {
          if (a.name === 'data-event' || a.name === 'data-event-bech32' || a.name === 'data-testid' ||
              a.name === 'role' || a.name === 'href' || a.name === 'class') {
            attrs.push(`${a.name}="${a.value.slice(0, 60)}"`);
          }
        }
        const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
        let s = `${'  '.repeat(depth)}<${tag}${attrStr}>`;
        for (const c of Array.from(el.children).slice(0, 8)) s += '\n' + describe(c, depth + 1);
        return s;
      };
      // Walk up to find the section that contains the primary note + replies.
      let container: Element = primary;
      for (let i = 0; i < 6; i++) {
        if (container.parentElement) container = container.parentElement;
      }
      return describe(container, 0);
    });
    fs.writeFileSync(out('primal-live-structure.txt'), liveStructure, 'utf8');

    // Also dump one reply note's class structure so we can see the avatar+name
    // selectors used in the replies (different from the primary note).
    const replyStructure = await page.evaluate(() => {
      const reply = document.querySelector('[class*="_noteThread_"]');
      if (!reply) return '(no _noteThread_ found)';
      const describe = (el: Element, depth: number): string => {
        if (depth > 6) return `${'  '.repeat(depth)}...`;
        const tag = el.tagName.toLowerCase();
        const cls = el.getAttribute('class') ?? '';
        let s = `${'  '.repeat(depth)}<${tag} class="${cls.slice(0, 80)}">`;
        for (const c of Array.from(el.children).slice(0, 8)) s += '\n' + describe(c, depth + 1);
        return s;
      };
      return describe(reply, 0);
    });
    fs.writeFileSync(out('primal-reply-structure.txt'), replyStructure, 'utf8');

    // Quoted/embedded note structure
    const quoteStructure = await page.evaluate(() => {
      const q = document.querySelector('a[class*="_mentionedNote_"], a[class*="embeddedNote"]');
      if (!q) return '(no _mentionedNote_ found)';
      const describe = (el: Element, depth: number): string => {
        if (depth > 6) return `${'  '.repeat(depth)}...`;
        const tag = el.tagName.toLowerCase();
        const cls = el.getAttribute('class') ?? '';
        let s = `${'  '.repeat(depth)}<${tag} class="${cls.slice(0, 80)}">`;
        for (const c of Array.from(el.children).slice(0, 8)) s += '\n' + describe(c, depth + 1);
        return s;
      };
      return describe(q, 0);
    });
    fs.writeFileSync(out('primal-quote-structure.txt'), quoteStructure, 'utf8');

    // Top zaps row structure
    const zapsStructure = await page.evaluate(() => {
      const z = document.querySelector('[class*="_topZaps_"], [class*="_zapHighlights_"]');
      if (!z) return '(no _topZaps_/_zapHighlights_ found)';
      const describe = (el: Element, depth: number): string => {
        if (depth > 5) return `${'  '.repeat(depth)}...`;
        const tag = el.tagName.toLowerCase();
        const cls = el.getAttribute('class') ?? '';
        let s = `${'  '.repeat(depth)}<${tag} class="${cls.slice(0, 80)}">`;
        for (const c of Array.from(el.children).slice(0, 8)) s += '\n' + describe(c, depth + 1);
        return s;
      };
      return describe(z, 0);
    });
    fs.writeFileSync(out('primal-zaps-structure.txt'), zapsStructure, 'utf8');

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

    // 2. Navigate to the web app /clips page and inject the clip.
    const libPage = await ctx.newPage();
    await libPage.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });

    await libPage.evaluate((capture) => {
      const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
        window.location.origin,
      );
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] },
        window.location.origin,
      );
    }, cap);

    // 3. Click the clip row to surface the DetailPanel with .clip-body.
    const row = libPage.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();

    const clipBody = libPage.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
    // Wait for any inlined data: images to paint.
    await libPage.waitForTimeout(1000);

    // 4. Screenshot just the clip body (tall-safe: viewport-clipped beyond 8k px).
    await screenshotClipBody(libPage, clipBody, out('primal-rendered.png'));

    // Third artifact: the PUBLIC cast render (kind-30023 markdown), built by the
    // extension's real BUILD_CAST path from this same capture.
    await castShotSafe(page, cap as { title?: string }, out('primal-cast.png'));

    // Also dump element box info for dx-* markers — find anything that's
    // sized 0 or out of view despite having content.
    const elementInfo = await clipBody.evaluate((root) => {
      const targets = Array.from(root.querySelectorAll('.dx-post, .dx-reply, .dx-quote, .dx-header'));
      return targets.map(el => {
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const text = (el.textContent ?? '').trim().slice(0, 50);
        return {
          tag: el.tagName.toLowerCase(),
          cls: el.className,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          top: Math.round(rect.top),
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          text,
        };
      });
    });
    fs.writeFileSync(out('primal-element-info.json'), JSON.stringify(elementInfo, null, 2), 'utf8');

    // ── Structural assertions ────────────────────────────────────────────────
    // Shared health checks (formerly inline here): header layout, reply
    // heights, zaps avatars, plus img distortion / text squeeze / blank runs /
    // chrome leaks. Runs after the screenshot so the artifact exists for
    // diagnosis even when an assertion fails.
    await assertClipBodyHealth(clipBody);

    // Also dump the body HTML to a file for inspection. Strip base64 data
    // URIs so the file is readable.
    const html = (await clipBody.evaluate((el) => el.innerHTML)) as string;
    const stripped = html.replace(/data:image\/[^"'\s]+/g, 'data:image/...(elided)...');
    fs.writeFileSync(out('primal-rendered.html'), html, 'utf8');
    fs.writeFileSync(out('primal-rendered-stripped.html'), stripped, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`\n✓ Saved primal-* artifacts to ${outDir}\n`);
  } finally {
    await ctx.close();
  }
});
