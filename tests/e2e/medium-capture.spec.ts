// Capture a Medium article via the extension and dump the captured bodyHtml
// so we can see what survives sanitisation and where the author header /
// engagement row land in the output.

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchWithExtension } from './helpers/launchExtension';

const URL =
  process.env.MEDIUM_URL ||
  'https://medium.com/cube-bitcoin/introducing-cube-8b3702e470a5';

test('capture medium article', async () => {
  test.skip(!process.env.MEDIUM, 'set MEDIUM=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
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
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(5_000);

    await page.screenshot({ path: out('medium-source.png'), fullPage: false });

    // Dump the live DOM header / engagement areas BEFORE capture so we can
    // see the markup the capture pipeline reads from.
    const live = await page.evaluate(() => {
      // Author byline strip
      const findHeader = (): { selector: string; html: string; tree: string } | null => {
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
        const describe = (el: Element, depth: number, max: number): string => {
          if (depth > max) return `${'  '.repeat(depth)}...`;
          const tag = el.tagName.toLowerCase();
          const attrs: string[] = [];
          for (const a of Array.from(el.attributes)) {
            if (a.name === 'class' || a.name === 'data-testid' || a.name === 'aria-label' || a.name === 'role' || a.name === 'href' || a.name === 'src' || a.name === 'alt') {
              attrs.push(`${a.name}="${a.value.slice(0, 80)}"`);
            }
          }
          const direct = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => (n.textContent ?? '').trim()).filter(Boolean).join(' | ');
          let s = `${'  '.repeat(depth)}<${tag} ${attrs.join(' ')}>`;
          if (direct) s += ` "${direct.slice(0, 60)}"`;
          for (const c of Array.from(el.children).slice(0, 20)) s += '\n' + describe(c, depth + 1, max);
          return s;
        };
        return {
          selector: smallest.tagName.toLowerCase() + (smallest.className ? '.' + smallest.className.split(/\s+/).slice(0, 2).join('.') : ''),
          html: smallest.outerHTML.slice(0, 1500),
          tree: describe(smallest, 0, 7),
        };
      };
      // Engagement row
      const findEngagement = (): { html: string; tree: string } | null => {
        const labels = ['clap', 'respond', 'comment', 'save', 'share', 'highlight'];
        const elements = Array.from(document.querySelectorAll('*')).filter(el => {
          const txt = (el.getAttribute('aria-label') ?? '').toLowerCase();
          return labels.some(l => txt.includes(l));
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
        if (!best) return null;
        const describe = (el: Element, depth: number, max: number): string => {
          if (depth > max) return `${'  '.repeat(depth)}...`;
          const tag = el.tagName.toLowerCase();
          const attrs: string[] = [];
          for (const a of Array.from(el.attributes)) {
            if (a.name === 'class' || a.name === 'data-testid' || a.name === 'aria-label' || a.name === 'role' || a.name === 'href') {
              attrs.push(`${a.name}="${a.value.slice(0, 60)}"`);
            }
          }
          const direct = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => (n.textContent ?? '').trim()).filter(Boolean).join(' | ');
          let s = `${'  '.repeat(depth)}<${tag} ${attrs.join(' ')}>`;
          if (direct) s += ` "${direct.slice(0, 40)}"`;
          for (const c of Array.from(el.children).slice(0, 20)) s += '\n' + describe(c, depth + 1, max);
          return s;
        };
        return { html: best.outerHTML.slice(0, 1500), tree: describe(best, 0, 5) };
      };
      return { header: findHeader(), engagement: findEngagement() };
    });

    writeFileSync(out('medium-live-header.txt'),
      `HEADER:\n${JSON.stringify(live.header, null, 2)}\n\nENGAGEMENT:\n${JSON.stringify(live.engagement, null, 2)}\n`, 'utf8');

    // Now capture via the dev test bridge.
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
      JSON.stringify({ ...cap, bodyHtml: ((cap.bodyHtml as string) ?? '').slice(0, 100000) }, null, 2),
      'utf8');

    // Render the clip in /clips
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
    await libPage.waitForTimeout(1500);

    // Screenshot the top portion of the rendered clip (where the header lives).
    const rect = await clipBody.boundingBox();
    if (rect) {
      await libPage.screenshot({
        path: out('medium-rendered-top.png'),
        clip: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(800, rect.height) },
      });
    }
  } finally {
    await ctx.close();
  }
});
