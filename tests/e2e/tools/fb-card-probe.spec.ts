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
    const BYLINE_SEL = 'h3 a, h4 a, h2 a, strong a[role="link"]';
    const MSG_SEL = '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]';
    const msgs = Array.from(document.querySelectorAll(MSG_SEL));
    lines.push(`story messages: ${msgs.length}`);
    lines.push(`role=article elements: ${document.querySelectorAll('[role="article"]').length}`);
    lines.push('');

    document.querySelectorAll('[role="article"]').forEach((a, i) => {
      const r = a.getBoundingClientRect();
      lines.push(`article#${i}: ${Math.round(r.width)}x${Math.round(r.height)} ` +
        `bylines=${a.querySelectorAll(BYLINE_SEL).length} ` +
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
        const bylines = p.querySelectorAll(BYLINE_SEL).length;
        const nMsgs = p.querySelectorAll(MSG_SEL).length;
        const isArticle = p.getAttribute('role') === 'article';
        const inArticle = !!p.closest('[role="article"]');
        // The first byline text inside this ancestor — is it the post's author?
        const firstByline = p.querySelector(BYLINE_SEL);
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
