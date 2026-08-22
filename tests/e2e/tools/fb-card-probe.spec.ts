// Offline analysis of the Facebook post-card boundary, run against the saved
// fixture (tests/fixtures/sites/facebook-feed.html) rather than the live feed.
//
// Four live attempts to make the captured card include the author byline all
// failed, because the feed serves a different post shape on every load. This
// probe walks the FROZEN tree and prints, for every story_message, the full
// ancestor chain annotated with: box, sibling count, how many bylines/messages
// each ancestor encloses, and where role="article" sits. The card boundary
// should be readable from that.
//
// Run: FBCARD=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//        --project=fb-card-probe

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output', 'fb-card-probe.txt');

test('fb-card-probe: find the post-card boundary offline', async ({ page }) => {
  test.skip(!process.env.FBCARD, 'set FBCARD=1 to run');
  test.setTimeout(120_000);

  await page.goto(process.env.FBCARD_URL ?? 'http://127.0.0.1:4173/facebook-feed.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(process.env.FBCARD_URL ? 9_000 : 2_000);

  const report = await page.evaluate(() => {
    const lines: string[] = [];
    const MSG_SEL = '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]';
    // Mirror of capture.ts's fbBylineAnchors — the feed has NO heading-wrapped
    // bylines, so the old `h3 a, …` selector reported 0 everywhere.
    const bylinesIn = (el: Element): HTMLAnchorElement[] =>
      Array.from(el.querySelectorAll<HTMLAnchorElement>('a[role="link"][href]')).filter(a => {
        const t = (a.textContent ?? '').trim();
        if (t.length < 2 || t.length > 60 || t.includes('\n')) return false;
        if (a.querySelector('img, svg')) return false;
        return /^https?:\/\/(www\.)?facebook\.com\/(profile\.php\?id=\d+|[A-Za-z0-9.]+)(\?|$|\/$)/
          .test(a.getAttribute('href') ?? '');
      });
    const msgs = Array.from(document.querySelectorAll(MSG_SEL));
    lines.push(`story messages: ${msgs.length}`);
    lines.push(`role=article elements: ${document.querySelectorAll('[role="article"]').length}`);
    lines.push('');

    document.querySelectorAll('[role="article"]').forEach((a, i) => {
      const r = a.getBoundingClientRect();
      lines.push(`article#${i}: ${Math.round(r.width)}x${Math.round(r.height)} ` +
        `bylines=${bylinesIn(a).length} ` +
        `msgs=${a.querySelectorAll(MSG_SEL).length} ` +
        `imgs=${a.querySelectorAll('img').length} ` +
        `text="${(a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
    });
    lines.push('');

    msgs.forEach((msg, mi) => {
      lines.push(`===== message #${mi}: "${(msg.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 55)}"`);
      let p: Element | null = msg;
      for (let i = 0; i < 16 && p && p !== document.body; i++) {
        const par: HTMLElement | null = p.parentElement;
        const sig = `${p.tagName.toLowerCase()}|${typeof p.className === 'string' ? p.className.trim() : ''}`;
        const sibs = par ? (Array.from(par.children) as Element[]).filter(c =>
          `${c.tagName.toLowerCase()}|${typeof c.className === 'string' ? c.className.trim() : ''}` === sig).length : 0;
        const r = p.getBoundingClientRect();
        const bylines = bylinesIn(p).length;
        const nMsgs = p.querySelectorAll(MSG_SEL).length;
        const isArticle = p.getAttribute('role') === 'article';
        const inArticle = !!p.closest('[role="article"]');
        // The first byline text inside this ancestor — is it the post's author?
        const firstByline = bylinesIn(p)[0] ?? null;
        const bylineTxt = (firstByline?.textContent ?? '').trim().slice(0, 24);
        // Does this ancestor hold the byline that belongs to THIS message, and
        // does it enclose only ONE message? A card holds exactly one post.
        const ownMsgs = p.querySelectorAll(MSG_SEL).length;
        const marker = (bylines >= 1 && ownMsgs <= 1) ? '   <== CANDIDATE CARD' : '';
        lines.push(`  ${i}: <${p.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)} ` +
          `sibs=${sibs} bylines=${bylines} msgs=${nMsgs} imgs=${p.querySelectorAll('img').length}` +
          `${isArticle ? ' [role=article]' : ''}${inArticle && !isArticle ? ' (inside article)' : ''}` +
          `${bylineTxt ? ` firstByline="${bylineTxt}"` : ''}${marker}`);
        p = par;
      }
      lines.push('');
    });
    return lines.join('\n');
  });

  writeFileSync(OUT, report, 'utf8');
  // eslint-disable-next-line no-console
  console.log(report);
});

// Exactly what the tagger's climb sees at each level: DEDUPED body count and
// shape-matched byline count, so the card-boundary stop condition can be read
// off directly rather than inferred from the raw chain above.
test('fb-card-probe: deduped climb', async ({ page }) => {
  test.skip(!process.env.FBCARD, 'set FBCARD=1 to run');
  await page.goto('http://127.0.0.1:4173/facebook-feed.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);
  const out = await page.evaluate(() => {
    const MSG_SEL = '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]';
    const bylinesIn = (el: Element) =>
      Array.from(el.querySelectorAll<HTMLAnchorElement>('a[role="link"][href]')).filter(a => {
        const t = (a.textContent ?? '').trim();
        if (t.length < 2 || t.length > 60 || t.includes('\n')) return false;
        if (a.querySelector('img, svg')) return false;
        return /^https?:\/\/(www\.)?facebook\.com\/(profile\.php\?id=\d+|[A-Za-z0-9.]+)(\?|$|\/$)/
          .test(a.getAttribute('href') ?? '');
      });
    const dedupIn = (el: Element) => {
      const r = Array.from(el.querySelectorAll(MSG_SEL));
      return r.filter(x => !r.some(o => o !== x && o.contains(x)));
    };
    const raw = Array.from(document.querySelectorAll(MSG_SEL));
    const bodies = raw.filter(el => !raw.some(o => o !== el && o.contains(el)));
    const L: string[] = [];
    bodies.forEach((body, bi) => {
      L.push(`=== post #${bi}: "${(body.textContent??'').replace(/\s+/g,' ').trim().slice(0,45)}"`);
      let node: Element | null = body;
      for (let i = 0; i < 14 && node && node.parentElement; i++) {
        node = node.parentElement!;
        if (node === document.body) { L.push('  (body)'); break; }
        const d = dedupIn(node).length, b = bylinesIn(node);
        const r = node.getBoundingClientRect();
        L.push(`  ${i}: ${Math.round(r.width)}x${Math.round(r.height)} dedupBodies=${d} bylines=${b.length}` +
          ` names=[${b.slice(0,3).map(x=>(x.textContent??'').trim()).join(', ')}]` +
          `${d>1?'  <-- BREAK (feed track)':(b.length>=1?'  <-- STOP (card)':'')}`);
        if (d > 1 || b.length >= 1) break;
      }
    });
    return L.join('\n');
  });
  // eslint-disable-next-line no-console
  console.log(out);
});

// Why the aria-hidden zero-area rule does not drop the 88 "Facebook"
// placeholders: measure the hidden container and the blockquote itself.
test('fb-card-probe: rendered gap', async ({ page }) => {
  test.skip(!process.env.FBGAP, 'set FBGAP=1 to run');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(resolve(__dirname, '..', '..', '..', 'test-output', 'fb-bodyhtml.html'), 'utf8');
  await page.setViewportSize({ width: 700, height: 1200 });
  await page.setContent(`<div class="clip-body">${html}</div>`);
  await page.waitForTimeout(500);
  const out = await page.evaluate(() => {
    const L: string[] = [];
    const root = document.querySelector('.clip-body')!;
    const all = Array.from(root.querySelectorAll('*'));
    const tall = all
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(x => x.r.height > 150)
      .sort((a, b) => b.r.height - a.r.height)
      .slice(0, 15);
    L.push(`clip-body height: ${Math.round(root.getBoundingClientRect().height)}`);
    tall.forEach(({ el, r }) => {
      const cs = getComputedStyle(el);
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      L.push(`  <${el.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)}` +
        ` disp=${cs.display} pos=${cs.position} pad=${cs.paddingTop}/${cs.paddingBottom}` +
        ` mh=${cs.minHeight} ar=${cs.aspectRatio} kids=${el.children.length} text="${txt}"`);
    });
    return L.join('\n');
  });
  // eslint-disable-next-line no-console
  console.log(out);
});

// The engagement/reaction footer: locate it in the LIVE fixture so the tagger
// can exclude it by a stable hook rather than by guessing at class names.
