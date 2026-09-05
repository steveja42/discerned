// Render a live feed capture through the real /clips view and screenshot it.
//
// The probe reports text/image COUNTS; this shows what the clip actually LOOKS
// like — the only way to answer "the reel has no image/poster". Feed video is
// the hard case: Instagram and Facebook both play MSE streams (`src="blob:"`,
// `poster` empty), so there is no poster attribute and no fetchable URL, and a
// still can only come from canvas-capturing the live frame.
//
// Run (Chrome fully closed):
//   FCR=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=feed-clip-render
// Options: FCR_ONLY=facebook-reels  FCR_HEADED=1

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';
import { buildCastTemplates } from '../helpers/castFromCapture';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');

const SITES: Record<string, string> = {
  'facebook-reels': 'https://www.facebook.com/reel/',
  'instagram-reels': process.env.FCR_URL ?? 'https://www.instagram.com/reels/DbnxT2Duur8/',
  'youtube-watch': process.env.FCR_YT_URL ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'instagram-home': 'https://www.instagram.com/',
  'facebook-home': 'https://www.facebook.com/',
  'facebook-post': 'https://www.facebook.com/photo/?fbid=10163039872376188',
  'tiktok-profile': 'https://www.tiktok.com/@nasa',
  'tiktok-foryou': 'https://www.tiktok.com/foryou',
};

const TARGETS = (() => {
  const only = process.env.FCR_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  if (!only?.length) return SITES;
  return Object.fromEntries(Object.entries(SITES).filter(([k]) => only.includes(k)));
})();

test('feed-clip-render: what the narrowed feed clip actually looks like', async () => {
  test.skip(!process.env.FCR, 'set FCR=1 to run');
  test.setTimeout(420_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.FCR_HEADED,
  });
  const lines: string[] = [];
  try {
    for (const [name, url] of Object.entries(TARGETS)) {
      const page = await ctx.newPage();
      const pipelineLogs: string[] = [];
      page.on('console', m => {
        const t = m.text();
        if (/tagFacebook|permalink|captured via|tagger|anchors/i.test(t)) pipelineLogs.push(t.slice(0, 180));
      });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForTimeout(10_000);
        // No broad host permission ships, so the content script binds only after
        // the real activation gesture — without this the capture bridge below
        // has no listener and every site reports "capture timeout".
        await activateExtensionOnTab(ctx, page.url());
        // Let the video actually start painting frames — canvas capture of a
        // not-yet-decoded video yields a blank frame.
        await page.evaluate(async () => {
          const v = document.querySelector('video');
          if (v) { try { await (v as HTMLVideoElement).play(); } catch { /* autoplay policy */ } }
        }).catch(() => undefined);
        await page.waitForTimeout(4_000);

        // Does the <video> survive markExcluded? It drops fixed/sticky/hidden
        // elements, and feed players are often absolutely positioned inside a
        // sized wrapper — which would remove the video BEFORE the poster
        // substitution ever sees it.
        const videoStyles = await page.evaluate(() => Array.from(document.querySelectorAll('video')).slice(0, 3).map(v => {
          const chain: string[] = [];
          let p: Element | null = v;
          for (let i = 0; i < 5 && p; i++) {
            const s = getComputedStyle(p);
            chain.push(`${p.tagName.toLowerCase()}[pos=${s.position},vis=${s.visibility},disp=${s.display}]`);
            p = p.parentElement;
          }
          return chain.join(' < ');
        }));
        lines.push(`video ancestry: ${JSON.stringify(videoStyles, null, 1)}`);

        // Is the playing <video> INSIDE the element narrowing would pick? If the
        // feed track's cards hold only the caption/actions while the player is a
        // sibling overlay, narrowing scopes the clip to a post that has no video.
        const containment = await page.evaluate(() => {
          const v = Array.from(document.querySelectorAll('video'))
            .find(x => !(x as HTMLVideoElement).paused) ?? document.querySelector('video');
          if (!v) return 'no video';
          const vw = innerWidth, vh = innerHeight;
          const share = (el: Element) => {
            const r = el.getBoundingClientRect();
            const oy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            const ox = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            return (ox * oy) / (vw * vh);
          };
          // Walk up from the video; report each ancestor's viewport share and how
          // many same-signature siblings it has (the narrowing signal).
          const out: string[] = [];
          let p: Element | null = v;
          for (let i = 0; i < 8 && p && p !== document.body; i++) {
            const par: HTMLElement | null = p.parentElement;
            const sig = `${p.tagName.toLowerCase()}|${p.className}`;
            const sibs = par ? (Array.from(par.children) as Element[])
              .filter(c => `${c.tagName.toLowerCase()}|${c.className}` === sig).length : 0;
            out.push(`${i}: <${p.tagName.toLowerCase()}> share=${share(p).toFixed(2)} sameSigSiblings=${sibs}`);
            p = par;
          }
          return out.join(' | ');
        });
        lines.push(`video containment: ${containment}`);

        // Why did markMediaForHoist bail? Reproduce its inputs on the live page:
        // the narrowed post, its largest medium, and its leading text block.
        const hoistInputs = await page.evaluate(() => {
          const vw = innerWidth, vh = innerHeight;
          // Re-find the narrowed post the same way the pipeline does.
          const containers = Array.from(document.querySelectorAll('main, main div, body > div'));
          let winner: Element | null = null; let bestArea = 0;
          for (const c of containers) {
            const kids = Array.from(c.children);
            if (kids.length < 3) continue;
            const bySig = new Map<string, Element[]>();
            for (const k of kids) {
              const sig = `${k.tagName.toLowerCase()}|${k.className}`;
              (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(k);
            }
            let items: Element[] = [];
            for (const g of bySig.values()) if (g.length > items.length) items = g;
            if (items.length < 3) continue;
            for (const it of items) {
              const r = it.getBoundingClientRect();
              const oy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
              const ox = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
              if (ox * oy > bestArea) { bestArea = ox * oy; winner = it; }
            }
          }
          if (!winner) return 'no narrowed post found';
          const media = Array.from(winner.querySelectorAll('video, img')).map(m => {
            const r = m.getBoundingClientRect();
            return { tag: m.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
          });
          const texts = Array.from(winner.querySelectorAll('p, span, div'))
            .filter(t => (t.textContent ?? '').trim().length > 60)
            .slice(0, 3).map(t => {
              const r = t.getBoundingClientRect();
              return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left), text: (t.textContent ?? '').trim().slice(0, 40) };
            });
          const wr = winner.getBoundingClientRect();
          return {
            post: { tag: winner.tagName.toLowerCase(), w: Math.round(wr.width), h: Math.round(wr.height), children: winner.children.length },
            mediaCount: media.length, media: media.slice(0, 4), texts,
          };
        });
        lines.push(`hoist inputs: ${JSON.stringify(hoistInputs, null, 1)}`);

        // Screenshot the SOURCE at capture time — these feeds serve different
        // posts on every load, so a clip can only be judged against the page it
        // actually came from.
        await page.screenshot({ path: resolve(OUT, `fcr-${name}-source.png`) });

        const media = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map(v => ({
          w: Math.round(v.getBoundingClientRect().width),
          h: Math.round(v.getBoundingClientRect().height),
          poster: (v as HTMLVideoElement).poster || null,
          src: ((v as HTMLVideoElement).currentSrc || '').slice(0, 40),
          readyState: (v as HTMLVideoElement).readyState,
          paused: (v as HTMLVideoElement).paused,
        })));
        lines.push(`\n===== ${name} =====\nlive <video>: ${JSON.stringify(media)}`);

        const cap = await page.evaluate(() => new Promise((res) => {
          const t = setTimeout(() => res({ error: 'capture timeout' }), 60_000);
          const on = (e: MessageEvent) => {
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(t); removeEventListener('message', on);
            res(e.data.error ? { error: e.data.error } : e.data.capture);
          };
          addEventListener('message', on);
          postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, location.origin);
        })) as Record<string, unknown>;
        const html = String((cap as { bodyHtml?: string }).bodyHtml ?? '');
        // Why don't the captured images render? Report each <img>'s tag as it
        // exists in the captured HTML (dimensions, wrapper, src kind) — a clip
        // with N images but a blank render means they are present but unsized,
        // zero-height, or inside a collapsed wrapper.
        const imgTags = (html.match(/<img[^>]*>/gi) ?? []).slice(0, 6)
          .map(t => t.replace(/src="data:[^"]{0,40}[^"]*"/g, 'src="data:…"').slice(0, 180));
        lines.push(`img tags: ${JSON.stringify(imgTags, null, 1)}`);
        // Player-control chrome: the Facebook reel clip renders ~30 stray glyphs
        // (play / CC / cast / volume / settings) that are not on the source page.
        // Report what they are in the CAPTURED html so the removal targets the
        // real markup rather than a guess.
        const svgCount = (html.match(/<svg/gi) ?? []).length;
        const ariaLabels = (html.match(/aria-label="[^"]{1,40}"/gi) ?? []).slice(0, 25);
        lines.push(`svgs in capture: ${svgCount}`);
        lines.push(`aria-labels: ${JSON.stringify(ariaLabels)}`);
        // BYLINE-TRACE: is the author text in the captured bodyText at all?
        lines.push(`bodyText head: ${JSON.stringify(String((cap as {bodyText?: string}).bodyText ?? '').replace(/\s+/g,' ').slice(0,220))}`);
        // HTML-TRACE: what text IS in the captured html?
        {
          const h = String((cap as {bodyHtml?: string}).bodyHtml ?? '');
          const stripped = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          lines.push(`html text (first 200): ${JSON.stringify(stripped.slice(0, 200))}`);
          // Which trusted classes actually survived sanitisation into the clip?
          // Stamped-on-the-live-page is not the same as present-in-the-capture,
          // and the difference is exactly where a layout silently dies.
          const cls = new Map<string, number>();
          for (const m of h.matchAll(/class="([^"]*)"/g)) {
            for (const c of m[1].split(/\s+/)) {
              if (c.startsWith('dx-') || c.startsWith('tweet-')) cls.set(c, (cls.get(c) ?? 0) + 1);
            }
          }
          lines.push(`classes in captured html: ${JSON.stringify(Object.fromEntries([...cls].sort()))}`);
          writeFileSync(resolve(OUT, `${name}-body.html`), h, 'utf8');
          // Build the REAL cast markdown too. The clip and the cast are
          // different render paths — htmlToMarkdown drops data:-only images and
          // every .dx-avatar — so a clip that looks right can still cast with
          // no image at all, which is not visible from the clip render.
          try {
            const tpl = await buildCastTemplates(page, cap);
            const md = tpl.longFormTemplate?.content ?? '';
            writeFileSync(resolve(OUT, `${name}-cast.md`), md, 'utf8');
            const imgs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
            lines.push(`cast markdown: ${md.length} chars, ${imgs.length} image(s)`);
            imgs.forEach(u => lines.push(`  cast img: ${u.split('?')[0].slice(-58)}`));
          } catch (e) {
            lines.push(`cast build FAILED: ${(e as Error).message.split('\n')[0]}`);
          }
          lines.push(`html has Eduardo: ${h.includes('Eduardo')}`);
        }
        lines.push(`pipeline: ${pipelineLogs.slice(0,6).join(' | ') || '(none)'}`);
        lines.push(`capture: imgs=${(html.match(/<img/g) ?? []).length} ` +
          `videos=${(html.match(/<video/g) ?? []).length} ` +
          `dataUri=${(html.match(/src="data:image/g) ?? []).length} ` +
          `httpImg=${(html.match(/src="https?:/g) ?? []).length} htmlLen=${html.length}`);

        // Render through the real /clips view.
        const lib = await ctx.newPage();
        try {
          await lib.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
          const marker = `fcr-${name}-${Date.now()}`;
          (cap as Record<string, unknown>).title = `${name} ${marker}`;
          for (let i = 0; i < 4; i++) {
            await lib.evaluate((capture) => {
              const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
              window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
              window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
            }, cap);
            const row = lib.locator('article.clip', { hasText: marker }).first();
            try { await row.waitFor({ state: 'visible', timeout: 8_000 }); await row.click(); break; }
            catch { /* re-post */ }
          }
          const body = lib.locator('.clip-body');
          await body.waitFor({ state: 'visible', timeout: 15_000 });
          await lib.waitForTimeout(2_000);
          // Measure the RENDERED images: a clip that carries images but shows
          // blank space means they are laid out at zero size or clipped by an
          // ancestor, not that they were dropped in capture.
          const rendered = await lib.evaluate(() => {
            const root = document.querySelector('.clip-body');
            if (!root) return 'no .clip-body';
            return Array.from(root.querySelectorAll('img')).slice(0, 6).map(im => {
              const r = im.getBoundingClientRect();
              const s = getComputedStyle(im);
              const chain: string[] = [];
              let p: Element | null = im.parentElement;
              for (let i = 0; i < 4 && p && p !== root; i++) {
                const pr = p.getBoundingClientRect();
                const ps = getComputedStyle(p);
                chain.push(`${p.tagName.toLowerCase()}[${Math.round(pr.width)}x${Math.round(pr.height)},disp=${ps.display},ovf=${ps.overflow}]`);
                p = p.parentElement;
              }
              return {
                rendered: `${Math.round(r.width)}x${Math.round(r.height)}`,
                natural: `${im.naturalWidth}x${im.naturalHeight}`,
                complete: im.complete, disp: s.display, vis: s.visibility,
                chain: chain.join(' < '),
              };
            });
          });
          lines.push(`rendered imgs: ${JSON.stringify(rendered, null, 1)}`);
          await body.screenshot({ path: resolve(OUT, `fcr-${name}-clip.png`) });
          lines.push(`rendered → fcr-${name}-clip.png`);
        } finally {
          await lib.close().catch(() => undefined);
        }
      } catch (e) {
        lines.push(`\n===== ${name} =====\nFAILED: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await ctx.close();
  }
  const out = lines.join('\n');
  writeFileSync(resolve(OUT, 'feed-clip-render.txt'), out, 'utf8');
  // eslint-disable-next-line no-console
  console.log(out);
});
