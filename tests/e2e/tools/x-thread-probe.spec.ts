// Diagnose the structure of an x.com CONVERSATION page, so reply capture can
// be built against measured markup rather than a guess about it.
//
// A status page renders the focused tweet, then its replies, then (often) an
// unrelated "Discover more" / "More Posts" rail — all as sibling
// <article data-testid="tweet"> elements in the same timeline container. The
// question this answers is what separates those three groups: which articles
// carry the focused tweet, which are genuine replies, and what marks the
// boundary past which the articles stop belonging to this conversation.
//
// Reports, per article: author handle, whether it is the focused tweet, the
// text head, any "Replying to" strip, the preceding non-article separator
// headings, and the aria/testid attributes on its enclosing cell.
//
// Run: XTHREAD=1 [XTHREAD_URL=<url>] pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=x-thread-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.XTHREAD_URL ?? 'https://x.com/CIA/status/2055074954375254084';

test('x-thread-probe', async () => {
  test.skip(!process.env.XTHREAD, 'set XTHREAD=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension({ profile: 'test', headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);
    // Replies load lazily; scroll a few screens so the probe sees them.
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);

    const report = await page.evaluate(() => {
      const out: string[] = [];
      const arts = Array.from(document.querySelectorAll('article'));
      out.push(`URL: ${location.href}`);
      out.push(`articles: ${arts.length}`);
      out.push(`  [data-testid="tweet"]: ${document.querySelectorAll('article[data-testid="tweet"]').length}`);
      out.push(`  [data-tweet-id]: ${document.querySelectorAll('article[data-tweet-id]').length}`);

      // DERIVE the shared container from the articles rather than assuming a
      // selector for it — the new X shape dropped the testids this used to key
      // on, so the container has to be found by walking up to the lowest
      // ancestor that holds every article.
      const lowestCommonAncestor = (els: Element[]): Element | null => {
        if (els.length === 0) return null;
        let cur: Element | null = els[0];
        while (cur && !els.every(e => cur!.contains(e))) cur = cur.parentElement;
        return cur;
      };
      const container = lowestCommonAncestor(arts);
      out.push(`container: ${container ? `${container.tagName} ${Array.from(container.attributes).map(a => `${a.name}="${a.value.slice(0, 60)}"`).join(' ')}` : 'NONE'}`);
      // The chain from container down to the first article names every wrapper
      // level a grouping rule could key on.
      if (container && arts[0]) {
        const chain: string[] = [];
        let c: Element | null = arts[0];
        while (c && c !== container) {
          chain.unshift(`${c.tagName}[${Array.from(c.attributes).map(a => `${a.name}=${a.value.slice(0, 40)}`).join(',') || 'no-attrs'}]`);
          c = c.parentElement;
        }
        out.push(`container→article chain (${chain.length} levels):`);
        chain.forEach(l => out.push(`    ${l}`));
      }
      // "Cells" = the container's direct children, each of which holds at most
      // one article plus any separator heading that precedes it.
      const cells = container ? Array.from(container.children) : [];
      out.push(`container children: ${cells.length}`);
      out.push('');
      out.push('=== CELLS IN DOCUMENT ORDER ===');

      cells.forEach((cell, i) => {
        const art = cell.querySelector('article');
        const head = (cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
        if (!art) {
          // A non-article cell: the separator that ends the conversation.
          out.push(`[${i}] NO-ARTICLE  text="${head}"`);
          const h = cell.querySelector('h2, h3, [role="heading"]');
          if (h) out.push(`      heading: "${(h.textContent ?? '').trim()}" role=${h.getAttribute('role')} tag=${h.tagName}`);
          return;
        }
        const handleA = Array.from(art.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
          .find(a => /^\/[A-Za-z0-9_]+$/.test(a.getAttribute('href') ?? ''));
        const handle = handleA?.getAttribute('href') ?? '?';
        // The focused tweet of a status page is the one whose own status link
        // matches the address bar.
        const statusLinks = Array.from(art.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
          .map(a => a.getAttribute('href') ?? '');
        const isFocused = statusLinks.some(h => location.pathname.startsWith(h.split('?')[0]));
        // "Replying to @x" strip.
        const replyingTo = Array.from(art.querySelectorAll<HTMLElement>('div, span'))
          .map(e => (e.textContent ?? '').trim())
          .find(t => /^Replying to/.test(t) && t.length < 120) ?? '';
        const txt = art.querySelector('[data-testid="tweetText"]')
          ?? Array.from(art.querySelectorAll<HTMLElement>('div[dir="auto"]'))[0];
        const socialCtx = art.querySelector('[data-testid="socialContext"]');
        out.push(`[${i}] ART handle=${handle} focused=${isFocused}`);
        out.push(`      text="${(txt?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"`);
        if (replyingTo) out.push(`      replyingTo="${replyingTo.slice(0, 80)}"`);
        if (socialCtx) out.push(`      socialContext="${(socialCtx.textContent ?? '').trim().slice(0, 60)}"`);
        out.push(`      statusLinks=${statusLinks.slice(0, 3).join(' , ') || 'none'}`);
        out.push(`      cellAttrs=${Array.from(cell.attributes).map(a => `${a.name}="${a.value}"`).join(' ') || 'none'}`);
        out.push(`      artAttrs=${Array.from(art.attributes).map(a => `${a.name}="${a.value}"`).join(' ') || 'none'}`);
        // A reply nests under the focused tweet's thread line; record depth so
        // an indentation-based grouping can be ruled in or out.
        out.push(`      tabindex=${art.getAttribute('tabindex')} rect.top=${Math.round(art.getBoundingClientRect().top + window.scrollY)}`);
      });

      // Every heading on the page in document order, with the article index it
      // precedes — this is what would mark "conversation ends here".
      out.push('');
      // Articles that are NOT inside the shared container — the sidebar's
      // "Relevant people" card is one, and it must not be mistaken for a reply.
      out.push('');
      out.push('=== ARTICLES PER CONTAINER CHILD ===');
      cells.forEach((cell, i) => {
        const arts2 = Array.from(cell.querySelectorAll('article'));
        const n = arts2.length;
        out.push(`  child[${i}] articles=${n}${n > 1 ? '  <-- MULTIPLE' : ''} text="${(cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
        if (n <= 1) return;
        // A multi-article cell is ambiguous: it can be ONE post whose card
        // nests its quoted tweet, or a BATCH of sibling replies X packed into
        // a single cell. Nesting is what separates them, so report it.
        const nested = arts2.filter(a => arts2.some(o => o !== a && o.contains(a))).length;
        out.push(`      outermost=${n - nested} nested=${nested}`);
        arts2.forEach((a, j) => {
          const parentArt = arts2.find(o => o !== a && o.contains(a));
          const handleA = Array.from(a.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
            .find(x => /^\/[A-Za-z0-9_]+$/.test(x.getAttribute('href') ?? ''));
          const own = Array.from(a.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
            .map(x => x.getAttribute('href') ?? '')
            .find(h => /^\/[A-Za-z0-9_]+\/status\/\d+/.test(h)) ?? 'none';
          const txt = (a.querySelector('div[dir="auto"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 45);
          out.push(`      art[${j}] ${parentArt ? 'NESTED-in-' + arts2.indexOf(parentArt) : 'OUTERMOST'} handle=${handleA?.getAttribute('href') ?? '?'} status=${own} text="${txt}"`);
        });
      });

      out.push('');
      out.push('=== ARTICLES OUTSIDE THE CONTAINER ===');
      arts.filter(a => !container || !container.contains(a)).forEach(a => {
        out.push(`  text="${(a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)}"`);
        out.push(`    ancestorAriaLabels=${(() => { const l: string[] = []; let c: Element | null = a; while (c) { const al = c.getAttribute('aria-label'); if (al) l.push(al.slice(0, 40)); c = c.parentElement; } return l.join(' < ') || 'none'; })()}`);
      });

      out.push('');
      out.push('=== HEADINGS IN DOCUMENT ORDER ===');
      document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach(h => {
        const t = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const after = arts.filter(a => a.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING).length;
        out.push(`  "${t.slice(0, 70)}" tag=${h.tagName} role=${h.getAttribute('role')} articlesBefore=${after}`);
      });

      return out.join('\n');
    });

    const outDir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, 'x-thread-probe.txt');
    writeFileSync(file, report, 'utf8');
    // eslint-disable-next-line no-console
    console.log(report);
    // eslint-disable-next-line no-console
    console.log(`\n[probe] wrote ${file}`);
  } finally {
    await ctx.close();
  }
});
