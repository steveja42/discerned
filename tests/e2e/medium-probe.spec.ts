// Probe Medium's article header so we can build a tagger that renders the
// captured clip with avatar + author + Follow + read-time + date on one line
// and the engagement glyph row on a second line.

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL =
  process.env.MEDIUM_URL ||
  'https://medium.com/cube-bitcoin/introducing-cube-8b3702e470a5';

test('probe medium article header + engagement row', async () => {
  test.skip(!process.env.PROBE_MED, 'set PROBE_MED=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

  const userDataDir = mkdtempSync(join(tmpdir(), 'discerned-probe-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--headless=new', '--no-sandbox', '--no-first-run'],
    viewport: { width: 1280, height: 2400 },
  });

  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(5_000);

    // 1. Locate the author/byline strip (avatar + name + Follow + read-time + date).
    //    Find element whose text contains "Follow" and "min read" near each other.
    const headerInfo = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const candidates = all.filter(el => {
        if (el.children.length === 0) return false;
        const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (txt.length > 400) return false;
        return /\bFollow\b/.test(txt) && /\d+\s*min read/i.test(txt);
      });
      // pick the smallest (innermost) ancestor that still contains both pieces
      const smallest = candidates.reduce<Element | null>((best, el) => {
        if (!best) return el;
        return (el.textContent?.length ?? 0) < (best.textContent?.length ?? 0) ? el : best;
      }, null);
      if (!smallest) return null;
      const describe = (el: Element, depth: number, max: number): string => {
        if (depth > max) return `${'  '.repeat(depth)}...`;
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const attrs: string[] = [];
        for (const a of Array.from(el.attributes)) {
          if (a.name === 'class' || a.name === 'data-testid' || a.name === 'aria-label'
              || a.name === 'role' || a.name === 'href' || a.name === 'src' || a.name === 'alt') {
            attrs.push(`${a.name}="${a.value.slice(0, 80)}"`);
          }
        }
        const direct = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => (n.textContent ?? '').trim()).filter(Boolean).join(' | ');
        const tag = el.tagName.toLowerCase();
        const layout = `disp=${cs.display}${cs.flexDirection !== 'row' ? ' fd=' + cs.flexDirection : ''} wh=${Math.round(rect.width)}x${Math.round(rect.height)}`;
        let s = `${'  '.repeat(depth)}<${tag} ${attrs.join(' ')}> [${layout}]`;
        if (direct) s += ` text="${direct.slice(0, 60)}"`;
        for (const c of Array.from(el.children).slice(0, 20)) s += '\n' + describe(c, depth + 1, max);
        return s;
      };
      return {
        smallestText: (smallest.textContent ?? '').slice(0, 200),
        tree: describe(smallest, 0, 6),
        parentTree: smallest.parentElement ? describe(smallest.parentElement, 0, 7) : '(no parent)',
      };
    });

    if (headerInfo) {
      writeFileSync(resolve(outDir, 'medium-header.txt'),
        `smallestText: ${headerInfo.smallestText}\n\nTREE:\n${headerInfo.tree}\n\nPARENT TREE:\n${headerInfo.parentTree}\n`,
        'utf8');
      // eslint-disable-next-line no-console
      console.log('header text:', headerInfo.smallestText);
      console.log('\n--- header tree ---');
      console.log(headerInfo.tree);
    } else {
      // eslint-disable-next-line no-console
      console.log('no header found');
    }

    // 2. Locate the engagement glyph row (clap count, comment count, share, save, etc.).
    const engagementInfo = await page.evaluate(() => {
      // Look for a flex row with multiple <button> or <a> children with svg icons
      // appearing close to the author header. Search for elements with aria-label
      // containing "clap", "respond", "save", "share".
      const labels = ['clap', 'respond', 'comment', 'save', 'share', 'highlight'];
      const elements = Array.from(document.querySelectorAll('*')).filter(el => {
        const txt = (el.getAttribute('aria-label') ?? '').toLowerCase();
        return labels.some(l => txt.includes(l));
      });
      if (elements.length === 0) return null;
      // Find common parent of multiple matches
      const parents = new Map<Element, number>();
      for (const el of elements) {
        let p: Element | null = el.parentElement;
        while (p && p !== document.body) {
          parents.set(p, (parents.get(p) ?? 0) + 1);
          p = p.parentElement;
        }
      }
      // Smallest parent containing >= 3 of them
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
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const attrs: string[] = [];
        for (const a of Array.from(el.attributes)) {
          if (a.name === 'class' || a.name === 'data-testid' || a.name === 'aria-label' || a.name === 'role' || a.name === 'href') {
            attrs.push(`${a.name}="${a.value.slice(0, 60)}"`);
          }
        }
        const direct = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => (n.textContent ?? '').trim()).filter(Boolean).join(' | ');
        const tag = el.tagName.toLowerCase();
        const layout = `disp=${cs.display}${cs.flexDirection !== 'row' ? ' fd=' + cs.flexDirection : ''} wh=${Math.round(rect.width)}x${Math.round(rect.height)}`;
        let s = `${'  '.repeat(depth)}<${tag} ${attrs.join(' ')}> [${layout}]`;
        if (direct) s += ` text="${direct.slice(0, 40)}"`;
        for (const c of Array.from(el.children).slice(0, 20)) s += '\n' + describe(c, depth + 1, max);
        return s;
      };
      return {
        engagementCount: elements.length,
        text: (best.textContent ?? '').slice(0, 200),
        tree: describe(best, 0, 5),
      };
    });

    if (engagementInfo) {
      writeFileSync(resolve(outDir, 'medium-engagement.txt'),
        `engagementCount: ${engagementInfo.engagementCount}\ntext: ${engagementInfo.text}\n\nTREE:\n${engagementInfo.tree}\n`,
        'utf8');
      // eslint-disable-next-line no-console
      console.log('\n--- engagement text ---', engagementInfo.text);
      console.log('--- engagement tree ---');
      console.log(engagementInfo.tree);
    } else {
      // eslint-disable-next-line no-console
      console.log('no engagement row found');
    }

    await page.screenshot({ path: resolve(outDir, 'medium-source.png'), fullPage: false });
  } finally {
    await ctx.close();
  }
});
