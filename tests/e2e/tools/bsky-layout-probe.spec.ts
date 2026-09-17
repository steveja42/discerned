// WHY does a bsky reply render its avatar, name and comment text all on ONE
// line in the clip?
//
// The rule has to be found by measuring the RENDERED clip, not by reading the
// cascade: three CSS guesses in a row failed on the GIF card because the
// element being styled was a flex ITEM of a surviving parent row, so the
// parent decided the layout. This renders a real capture through the real
// .clip-body stylesheet and reports, per reply: the geometry of the avatar /
// name / body, which ancestor is a flex or grid container, and what set it.
//
// Run: BLAY=1 [BLAY_URL=<url>] pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=bsky-layout-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const URL = process.env.BLAY_URL
  ?? 'https://bsky.app/profile/tiredsleepyzzz.bsky.social/post/3mvpot4yxlc2o';

test('bsky-layout-probe', async () => {
  test.skip(!process.env.BLAY, 'set BLAY=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension();
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(7000);
    await activateExtensionOnTab(ctx, URL);

    const cap = (await page.evaluate(async () => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('capture timeout')), 60_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); window.removeEventListener('message', on);
        if (e.data.error) rej(new Error(e.data.error)); else res(e.data.capture);
      };
      window.addEventListener('message', on);
      window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
    }))) as Record<string, unknown>;

    const lib = await ctx.newPage();
    await lib.setViewportSize({ width: 610, height: 900 });
    await lib.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await lib.evaluate((c) => {
      const clip = { capture: c, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, cap);
    await lib.locator('article.clip').first().click({ timeout: 15_000 });
    await lib.locator('.clip-body').waitFor({ state: 'visible', timeout: 15_000 });
    await lib.waitForTimeout(1200);

    const report = await lib.evaluate(() => {
      const out: string[] = [];
      const root = document.querySelector('.clip-body')!;
      const allPosts = Array.from(root.querySelectorAll('.dx-post'));
      // Whole-clip verdict FIRST: sampling a few crops is how a byline defect
      // got reported as fixed while most posts were still wrong.
      let ok = 0, bad = 0;
      const badList: string[] = [];
      allPosts.forEach((p, i) => {
        const a = p.querySelector('img.dx-avatar');
        if (!a) return;
        const at = a.getBoundingClientRect();
        const cand = Array.from(p.querySelectorAll('a'))
          .filter(x => /\/profile\//.test(x.getAttribute('href') ?? '')
            && (x.textContent ?? '').trim().length > 0 && !x.querySelector('img'))
          .sort((x, y) => Math.abs(x.getBoundingClientRect().top - at.top)
            - Math.abs(y.getBoundingClientRect().top - at.top))[0];
        if (!cand) return;
        const nt = cand.getBoundingClientRect();
        const sameLine = !(at.bottom <= nt.top + 2 || nt.bottom <= at.top + 2);
        if (sameLine) ok++; else { bad++; badList.push(`post[${i}] deltaY=${Math.round(nt.top - at.top)} "${(cand.textContent ?? '').trim().slice(0, 24)}"`); }
      });
      out.push(`=== BYLINE VERDICT: ${ok} on one line, ${bad} WRONG (of ${allPosts.length} posts) ===`);
      badList.slice(0, 12).forEach(b => out.push(`    ${b}`));
      out.push('');

      const posts = allPosts.slice(0, 6);
      out.push(`posts examined in detail: ${posts.length}`);
      posts.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        out.push(`\n=== post[${i}] ${Math.round(r.width)}x${Math.round(r.height)} @top=${Math.round(r.top)}`);
        out.push(`    display=${cs.display} flexDirection=${cs.flexDirection} flexWrap=${cs.flexWrap}`);
        const av = p.querySelector('img.dx-avatar');
        const hdr = p.querySelector('.dx-header');
        const label = (el: Element | null, name: string) => {
          if (!el) { out.push(`    ${name}: NONE`); return; }
          const rr = el.getBoundingClientRect();
          const c2 = getComputedStyle(el);
          out.push(`    ${name}: ${Math.round(rr.width)}x${Math.round(rr.height)} @top=${Math.round(rr.top)} left=${Math.round(rr.left)} display=${c2.display} float=${c2.float}`);
        };
        label(av, 'avatar');
        label(hdr, 'dx-header');
        // The byline anchor must be the one NEAREST the avatar — an earlier
        // version took the first /profile/ link in the post, which on a reply
        // containing an @mention matched a link ~500px down in the body and
        // reported a false "not on the same line" for posts that render
        // correctly. Restrict to links that start within one line-height of
        // the avatar's own top.
        const avTop = av ? av.getBoundingClientRect().top : 0;
        const nameA = Array.from(p.querySelectorAll('a'))
          .filter(a => /\/profile\//.test(a.getAttribute('href') ?? '')
            && (a.textContent ?? '').trim().length > 0
            && !a.querySelector('img'))
          .sort((x, y) => Math.abs(x.getBoundingClientRect().top - avTop)
            - Math.abs(y.getBoundingClientRect().top - avTop))[0];
        label(nameA ?? null, 'name-anchor');
        // The avatar's own header and that header's direct children — this is
        // what the float rules actually target, so it is what must be read
        // before writing another one.
        if (hdr) {
          Array.from(hdr.children).forEach((ch, j) => {
            const rr = ch.getBoundingClientRect();
            const c2 = getComputedStyle(ch);
            const hasName = !!ch.querySelector('a[href*="/profile/"]');
            const hasAv = !!ch.querySelector('img.dx-avatar') || ch === av;
            out.push(`    hdrChild[${j}] <${ch.tagName.toLowerCase()}> ${Math.round(rr.width)}x${Math.round(rr.height)} @top=${Math.round(rr.top)} display=${c2.display} overflow=${c2.overflow} hasNameLink=${hasName} hasAvatar=${hasAv}`);
          });
        }
        if (av && nameA) {
          const ar = av.getBoundingClientRect();
          const nr = nameA.getBoundingClientRect();
          const sameLine = !(ar.bottom <= nr.top + 2 || nr.bottom <= ar.top + 2);
          out.push(`    AVATAR/NAME same line: ${sameLine}  avatarBottom=${Math.round(ar.bottom)} nameTop=${Math.round(nr.top)} deltaY=${Math.round(nr.top - ar.top)}`);
          // What lays out the avatar's own parent — that is the row, or isn't.
          const ap = av.parentElement;
          if (ap) {
            const c3 = getComputedStyle(ap);
            out.push(`    avatarParent <${ap.tagName.toLowerCase()}> display=${c3.display} dir=${c3.flexDirection} wrap=${c3.flexWrap} class="${String(ap.className).slice(0, 40)}"`);
          }
        }
        // The post's direct children: what actually forms the row.
        Array.from(p.children).forEach((ch, j) => {
          const rr = ch.getBoundingClientRect();
          const c2 = getComputedStyle(ch);
          const txt = (ch.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 42);
          out.push(`    child[${j}] <${ch.tagName.toLowerCase()}> ${Math.round(rr.width)}x${Math.round(rr.height)} @top=${Math.round(rr.top)} display=${c2.display} "${txt}"`);
        });
        // Which ancestor made this a row?
        let cur: Element | null = p;
        for (let d = 0; d < 4 && cur; d++) {
          const c2 = getComputedStyle(cur);
          if (c2.display.includes('flex') || c2.display.includes('grid')) {
            out.push(`    ancestor[${d}] <${cur.tagName.toLowerCase()}> class="${cur.className}" display=${c2.display} dir=${c2.flexDirection}`);
          }
          cur = cur.parentElement;
        }
      });
      return out.join('\n');
    });

    const dir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'bsky-layout-probe.txt'), report, 'utf8');
    await lib.screenshot({ path: resolve(dir, 'bsky-layout-probe.png'), fullPage: false });
    // eslint-disable-next-line no-console
    console.log(report);
  } finally {
    await ctx.close();
  }
});
