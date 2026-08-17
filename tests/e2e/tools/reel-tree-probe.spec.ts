// Dump the REAL DOM tree of a narrowed reel post.
//
// Three attempts to reorder the reel clip (media above caption) were written
// against an ASSUMED structure and all three no-opped on the live page. This
// prints the actual tree — every node from the narrowed post down, with box,
// child count, and whether it contains the hero media / the caption — so the
// reorder can be written against what is really there.
//
// Run (Chrome fully closed):
//   REEL=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=reel-tree-probe
// Options: REEL_URL=<url>

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const URL_ = process.env.REEL_URL ?? 'https://www.instagram.com/reels/DbnxT2Duur8/';

test('reel-tree-probe: dump the narrowed post tree', async () => {
  test.skip(!process.env.REEL, 'set REEL=1 to run');
  test.setTimeout(240_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: false,
  });
  const page = await ctx.newPage();
  let out = '';
  try {
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(10_000);

    out = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const shareOf = (el: Element) => {
        const r = el.getBoundingClientRect();
        const oy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const ox = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        return (ox * oy) / (vw * vh);
      };

      // Reproduce maybeNarrowToVisiblePost's selection exactly: the largest
      // same-signature sibling group whose top item dominates the viewport.
      let winner: Element | null = null;
      let winnerInfo = '';
      const all = Array.from(document.querySelectorAll('body *'));
      for (const container of all) {
        const kids = Array.from(container.children);
        if (kids.length < 3) continue;
        const bySig = new Map<string, Element[]>();
        for (const k of kids) {
          const sig = `${k.tagName.toLowerCase()}|${k.className}`;
          const arr = bySig.get(sig) ?? [];
          arr.push(k); bySig.set(sig, arr);
        }
        let items: Element[] = [];
        for (const g of bySig.values()) if (g.length > items.length) items = g;
        if (items.length < 3) continue;
        const shares = items.map(shareOf);
        const top = Math.max(...shares);
        const visible = shares.filter(s => s > 0.05).length;
        if (visible <= 1 && top >= 0.5) {
          winner = items[shares.indexOf(top)];
          winnerInfo = `track=<${container.tagName.toLowerCase()}> items=${items.length} topShare=${top.toFixed(2)}`;
          break;
        }
      }
      if (!winner) return 'NO NARROWED POST FOUND';

      // Identify hero media + caption the way markMediaForHoist does.
      const mediaEls = Array.from(winner.querySelectorAll('video, img')).filter(m => {
        const r = m.getBoundingClientRect();
        return r.width >= 150 && r.height >= 150;
      });
      const hero = mediaEls.length
        ? mediaEls.reduce((best, m) => {
          const a = m.getBoundingClientRect(), b = best.getBoundingClientRect();
          return (a.width * a.height) > (b.width * b.height) ? m : best;
        })
        : null;
      const caption = Array.from(winner.querySelectorAll('p, span, div'))
        .find(t => (t.textContent ?? '').trim().length > 60 && (!hero || !t.contains(hero))) ?? null;

      const lines: string[] = [winnerInfo];
      const wr = winner.getBoundingClientRect();
      lines.push(`POST <${winner.tagName.toLowerCase()}> ${Math.round(wr.width)}x${Math.round(wr.height)} children=${winner.children.length}`);
      lines.push(`hero: ${hero ? `<${hero.tagName.toLowerCase()}> ${Math.round(hero.getBoundingClientRect().width)}x${Math.round(hero.getBoundingClientRect().height)} @${Math.round(hero.getBoundingClientRect().left)},${Math.round(hero.getBoundingClientRect().top)}` : 'NONE'}`);
      lines.push(`caption: ${caption ? `<${caption.tagName.toLowerCase()}> @${Math.round(caption.getBoundingClientRect().left)},${Math.round(caption.getBoundingClientRect().top)} "${(caption.textContent ?? '').trim().slice(0, 40)}"` : 'NONE'}`);
      lines.push('');
      lines.push('TREE (depth: tag box children | hasHero hasCaption):');

      const walk = (el: Element, depth: number) => {
        if (depth > 12) return;
        const r = el.getBoundingClientRect();
        const hasHero = hero ? el.contains(hero) : false;
        const hasCap = caption ? el.contains(caption) : false;
        // Only print nodes on the path to hero/caption, plus their siblings.
        if (!hasHero && !hasCap && depth > 0) return;
        const pad = '  '.repeat(depth);
        lines.push(`${pad}${depth}: <${el.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)} ` +
          `kids=${el.children.length} | hero=${hasHero} cap=${hasCap}` +
          (el === hero ? '  <== HERO' : '') + (el === caption ? '  <== CAPTION' : ''));
        // At the SPLIT point (contains both, and children divide them) list all
        // children so the reorder target is unambiguous.
        if (hasHero && hasCap) {
          const kids = Array.from(el.children);
          const heroKid = kids.findIndex(k => hero && k.contains(hero));
          const capKid = kids.findIndex(k => caption && k.contains(caption));
          if (heroKid !== -1 && capKid !== -1 && heroKid !== capKid) {
            lines.push(`${pad}   *** SPLIT HERE: heroChild=#${heroKid} captionChild=#${capKid} of ${kids.length} ***`);
            kids.forEach((k, i) => {
              const kr = k.getBoundingClientRect();
              lines.push(`${pad}     child#${i} <${k.tagName.toLowerCase()}> ${Math.round(kr.width)}x${Math.round(kr.height)} ` +
                `@${Math.round(kr.left)},${Math.round(kr.top)} text="${(k.textContent ?? '').trim().slice(0, 30)}"`);
            });
          }
        }
        Array.from(el.children).forEach(c => walk(c, depth + 1));
      };
      walk(winner, 0);
      return lines.join('\n');
    });
  } catch (e) {
    out = `FAILED: ${(e as Error).message.split('\n')[0]}`;
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close();
  }
  writeFileSync(resolve(OUT, 'reel-tree.txt'), out, 'utf8');
  // eslint-disable-next-line no-console
  console.log(out);
});
