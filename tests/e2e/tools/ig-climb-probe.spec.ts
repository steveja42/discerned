// Why tagInstagramReel bails: walk up from the visible <video> and report, per
// level, the video count and whether a caption block is in scope. Answers
// whether the climb ever sees "1 video + caption" before a sibling reel joins.
import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');
const URL_ = process.env.CLIMB_URL ?? 'https://www.instagram.com/reels/Dc1goBzv1Rm/';

test('ig-climb-probe: ancestor chain from the visible reel video', async () => {
  test.skip(!process.env.CLIMB, 'set CLIMB=1');
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
    // The tagger stamps dx-* only during a capture, so run one first —
    // otherwise the "stamped classes" section below always reports none.
    await activateExtensionOnTab(ctx, page.url());
    await page.evaluate(() => new Promise<void>((res) => {
      const t = setTimeout(() => res(), 40_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); removeEventListener('message', on); res();
      };
      addEventListener('message', on);
      postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
    }));
    out = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const vids = Array.from(document.querySelectorAll('video'));
      const areaOf = (el: Element) => {
        const r = el.getBoundingClientRect();
        const oy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const ox = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        return ox * oy;
      };
      const visible = vids.slice().sort((a, b) => areaOf(b) - areaOf(a))[0];
      if (!visible) return 'NO VIDEO';
      const lines = [`total videos on page: ${vids.length}`,
        `visible video area: ${Math.round(areaOf(visible))}`, ''];
      const captionOf = (el: Element) =>
        Array.from(el.querySelectorAll('a[href^="/"]'))
          .map(a => a.closest('div'))
          .find(d => d && (d.textContent ?? '').replace(/\s+/g, ' ').trim().length > 60) ?? null;
      let el: Element = visible;
      for (let i = 0; i < 14 && el.parentElement; i++) {
        el = el.parentElement;
        const r = el.getBoundingClientRect();
        const nv = el.querySelectorAll('video').length;
        const cap = captionOf(el);
        const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        lines.push(`L${i + 1}: <${el.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)} ` +
          `videos=${nv} caption=${cap ? 'YES' : 'no'} textLen=${txt.length} text="${txt.slice(0, 60)}"`);
        if (nv > 1 && cap) { lines.push('   ^ first level with caption ALSO has >1 video'); break; }
      }
      // What the tagger actually stamped on the live page.
      const stamped = new Map<string, number>();
      document.querySelectorAll('[class]').forEach(el => {
        const cn = typeof el.className === 'string'
          ? el.className
          : ((el.className as unknown as SVGAnimatedString)?.baseVal ?? '');
        cn.split(/\s+/).filter(c => c.startsWith('dx-'))
          .forEach(c => stamped.set(c, (stamped.get(c) ?? 0) + 1));
      });
      // Do the glyph exclusions swallow the <video> or the cover frame? A
      // dx-excl ancestor means removeMarked deletes that whole subtree.
      lines.push('', 'dx-excl containment check:');
      {
        const excls = Array.from(document.querySelectorAll('.dx-excl'));
        lines.push(`  dx-excl elements: ${excls.length}`);
        const swallowsVideo = excls.filter(e => e.contains(visible));
        lines.push(`  dx-excl ancestors CONTAINING the visible video: ${swallowsVideo.length}`);
        for (const e of swallowsVideo.slice(0, 3)) {
          const r = e.getBoundingClientRect();
          lines.push(`    <${e.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)} ` +
            `imgs=${e.querySelectorAll('img').length} videos=${e.querySelectorAll('video').length}`);
        }
        const bigImgs = Array.from(document.querySelectorAll('img')).filter(i => {
          const r = i.getBoundingClientRect(); return r.width >= 150 && r.height >= 150;
        });
        const swallowedImgs = bigImgs.filter(i => excls.some(e => e.contains(i)));
        lines.push(`  large imgs inside a dx-excl: ${swallowedImgs.length} of ${bigImgs.length}`);
      }
      // Where does the cover-frame <img> sit relative to the <video>? The
      // dedupe needs the real distance, not an assumed one.
      lines.push('', 'cover-frame <img> vs the visible <video>:');
      {
        const big = Array.from(document.querySelectorAll('img')).filter(i => {
          const r = i.getBoundingClientRect();
          return r.width >= 150 && r.height >= 150;
        });
        lines.push(`  large imgs on page: ${big.length}`);
        for (const img of big.slice(0, 4)) {
          // How many levels up from the video until an ancestor contains img?
          let lv = -1, a: Element | null = visible;
          for (let i = 0; i < 25 && a; i++) { if (a.contains(img)) { lv = i; break; } a = a.parentElement; }
          const r = img.getBoundingClientRect();
          lines.push(`  img ${Math.round(r.width)}x${Math.round(r.height)} alt="${img.getAttribute('alt') ?? ''}" ` +
            `→ shared ancestor ${lv} level(s) above the video`);
        }
      }
      // Where does the engagement rail actually live? Report the Like glyph's
      // ancestor chain so the rail container can be selected from measurement
      // rather than guessed.
      const like = document.querySelector('svg[aria-label="Like"]');
      lines.push('', 'Like-glyph ancestor chain:');
      if (!like) lines.push('  (no svg[aria-label="Like"] found)');
      else {
        let a: Element | null = like;
        for (let i = 0; i < 8 && a; i++) {
          const r = a.getBoundingClientRect();
          const txt = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
          lines.push(`  A${i}: <${a.tagName.toLowerCase()}> role=${a.getAttribute('role') ?? '-'} ` +
            `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)} ` +
            `kids=${a.children.length} svgs=${a.querySelectorAll('svg').length} text="${txt.slice(0, 40)}"`);
          a = a.parentElement;
        }
      }
      lines.push('', 'dx-* classes stamped on the LIVE page:');
      if (!stamped.size) lines.push('  (none — tagger stamped nothing)');
      for (const [c, n] of [...stamped.entries()].sort()) lines.push(`  ${c}: ${n}`);
      return lines.join('\n');
    });
  } catch (e) { out = `FAILED: ${(e as Error).message.split('\n')[0]}`; }
  finally { await page.close().catch(() => undefined); await ctx.close(); }
  writeFileSync(resolve(OUT, 'ig-climb.txt'), out, 'utf8');
  console.log(out);
});
