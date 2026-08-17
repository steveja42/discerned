// Selector reconnaissance for the Instagram / Facebook / TikTok taggers.
//
// The home feeds cannot be scoped generically (measured: viewport dominance,
// self-contained <article> items, and unboundedness all fail to separate an
// instagram-home post from a bsky thread reply — see feed-post-probe). So they
// need per-site taggers, and a tagger is only as good as its selectors.
//
// This dumps, for each site: the repeating post containers it can find via
// stable-looking hooks, plus each post's author / caption / media / stats
// sub-elements. Feeds the SITE_TAGGERS entries + their `anchors` manifests.
//
// Run (Chrome fully closed, logged-in warm profile):
//   STP=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=social-tagger-probe
// Options: STP_ONLY=tiktok  STP_HEADED=1

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');

const SITES: Record<string, string> = {
  'instagram-home': 'https://www.instagram.com/',
  'facebook-home': 'https://www.facebook.com/',
  'facebook-post': 'https://www.facebook.com/photo/?fbid=10163039872376188',
  'tiktok-foryou': 'https://www.tiktok.com/foryou',
  'tiktok-profile': 'https://www.tiktok.com/@nasa',
};

const TARGETS = (() => {
  const only = process.env.STP_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  if (!only?.length) return SITES;
  return Object.fromEntries(Object.entries(SITES).filter(([k]) => only.includes(k)));
})();

test('social-tagger-probe: find stable post/author/media hooks', async () => {
  test.skip(!process.env.STP, 'set STP=1 to run');
  test.setTimeout(420_000);

  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.STP_HEADED,
  });
  const lines: string[] = [];
  try {
    for (const [name, url] of Object.entries(TARGETS)) {
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForTimeout(10_000);
        // Dismiss browser/site interstitials that cover the feed ("Remember
        // Password", cookie prompts) — otherwise the probe measures the dialog's
        // page instead of the feed underneath it.
        for (const label of ['Not Now', 'Not now', 'Decline optional cookies', 'Allow all cookies', 'Close']) {
          const btn = page.getByRole('button', { name: label, exact: false }).first();
          if (await btn.count().catch(() => 0)) {
            await btn.click({ timeout: 3_000 }).catch(() => undefined);
            await page.waitForTimeout(1_200);
          }
        }
        // Scroll a little so lazy feed items mount.
        await page.mouse.wheel(0, 700);
        await page.waitForTimeout(4_000);
        await page.screenshot({ path: resolve(OUT, `stp-${name}.png`) });

        const info = await page.evaluate(() => {
          const vw = innerWidth, vh = innerHeight;
          const shareOf = (el: Element) => {
            const r = el.getBoundingClientRect();
            const oy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            const ox = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            return +((ox * oy) / (vw * vh)).toFixed(2);
          };
          // Candidate post-container hooks: semantic tags + stable-looking
          // data attributes (NOT hashed class names, which change per build).
          const CANDIDATES = [
            'article', '[role="article"]',
            '[data-e2e="recommend-list-item-container"]', '[data-e2e="user-post-item"]',
            '[data-e2e]', '[data-pagelet]', '[data-visualcompletion="ignore-dynamic"]',
            '[data-testid]', '[data-id]', 'div[data-index]',
          ];
          const found: Record<string, unknown>[] = [];
          for (const sel of CANDIDATES) {
            let els: Element[];
            try { els = Array.from(document.querySelectorAll(sel)); } catch { continue; }
            if (!els.length) continue;
            // Keep only post-sized boxes.
            const sized = els.filter(e => {
              const r = e.getBoundingClientRect();
              return r.width > 200 && r.height > 150;
            });
            if (!sized.length) continue;
            const sample = sized[0];
            found.push({
              sel, total: els.length, postSized: sized.length,
              sampleShare: shareOf(sample),
              sampleAttrs: sample.getAttributeNames().slice(0, 8)
                .map(a => `${a}=${(sample.getAttribute(a) ?? '').slice(0, 40)}`),
              sampleText: (sample.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
              hasVideo: sample.querySelector('video') !== null,
              hasImg: sample.querySelectorAll('img').length,
              hasTime: sample.querySelector('time') !== null,
            });
          }
          // Distinct data-e2e / data-pagelet / data-testid values — the stable
          // naming schemes these three sites actually use.
          const attrValues = (attr: string) => {
            const vals = new Map<string, number>();
            for (const e of Array.from(document.querySelectorAll(`[${attr}]`))) {
              const v = e.getAttribute(attr) ?? '';
              vals.set(v, (vals.get(v) ?? 0) + 1);
            }
            return [...vals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)
              .map(([v, n]) => `${v}(${n})`);
          };
          // For the best post-container candidate, describe ONE post's innards —
          // this is what the tagger must stamp (dx-header / dx-author / dx-stats).
          let postAnatomy: unknown = null;
          const best = found.find(f => (f.postSized as number) >= 2) ?? found[0];
          if (best) {
            const el = Array.from(document.querySelectorAll(best.sel as string))
              .filter(e => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 150; })
              .sort((a, b) => shareOf(b) - shareOf(a))[0];
            if (el) {
              const desc = (sel: string) => Array.from(el.querySelectorAll(sel)).slice(0, 3).map(x => ({
                tag: x.tagName.toLowerCase(),
                cls: typeof x.className === 'string' ? x.className.slice(0, 40) : '',
                text: (x.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 45),
              }));
              postAnatomy = {
                share: shareOf(el),
                links: desc('a[href]'),
                headings: desc('h1,h2,h3,[role="heading"]'),
                times: desc('time'),
                imgs: Array.from(el.querySelectorAll('img')).slice(0, 4).map(i => {
                  const r = i.getBoundingClientRect();
                  return `${Math.round(r.width)}x${Math.round(r.height)} alt=${(i.getAttribute('alt') ?? '').slice(0, 25)}`;
                }),
                videoPosters: Array.from(el.querySelectorAll('video')).map(v =>
                  ((v as HTMLVideoElement).poster || '(none)').slice(0, 60)),
                textHead: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
              };
            }
          }
          // Fallback recon: when no declared hook matches, walk UP from a real
          // visible post's text and report each ancestor's identity + how many
          // same-signature siblings it has. This is how to find the feed track
          // on a site whose posts carry no stable attribute (Facebook).
          let ancestryFromText: unknown = null;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          const seeds: Element[] = [];
          while ((node = walker.nextNode())) {
            const txt = (node.textContent ?? '').trim();
            if (txt.length < 25) continue;
            const p = node.parentElement;
            if (!p) continue;
            const r = p.getBoundingClientRect();
            if (r.top < 0 || r.top > vh || r.width < 120) continue;
            seeds.push(p);
            if (seeds.length >= 1) break;
          }
          if (seeds.length) {
            const chain: string[] = [];
            let p: Element | null = seeds[0];
            for (let i = 0; i < 12 && p && p !== document.body; i++) {
              const par: HTMLElement | null = p.parentElement;
              const sig = `${p.tagName.toLowerCase()}|${typeof p.className === 'string' ? p.className.trim() : ''}`;
              const sibs = par ? (Array.from(par.children) as Element[]).filter(c =>
                `${c.tagName.toLowerCase()}|${typeof c.className === 'string' ? c.className.trim() : ''}` === sig).length : 0;
              const attrs = p.getAttributeNames().filter(a => a.startsWith('data-') || a === 'role')
                .map(a => `${a}=${(p!.getAttribute(a) ?? '').slice(0, 30)}`).join(',');
              chain.push(`${i}:<${p.tagName.toLowerCase()}> share=${shareOf(p)} sibs=${sibs}${attrs ? ' [' + attrs + ']' : ''}`);
              p = par;
            }
            ancestryFromText = { seedText: (seeds[0].textContent ?? '').trim().slice(0, 60), chain };
          }
          // Facebook: does the container tagFacebook climbs to (from
          // story_message) actually CONTAIN the author header? The rendered clip
          // showed photos + caption but no byline, which would mean the header
          // is a SIBLING above the body, outside the chosen post element.
          let fbHeaderCheck: unknown = null;
          const storyBody = document.querySelector(
            '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]');
          if (storyBody) {
            let post: Element | null = storyBody;
            for (let i = 0; i < 12 && post && post.parentElement; i++) {
              const parent: HTMLElement | null = post.parentElement;
              if (!parent || parent === document.body) break;
              const sig = `${post.tagName.toLowerCase()}|${post.className}`;
              const sibs = (Array.from(parent.children) as Element[]).filter(c =>
                `${c.tagName.toLowerCase()}|${c.className}` === sig).length;
              const r = post.getBoundingClientRect();
              if (sibs >= 2 && r.height > 200) break;
              post = parent;
            }
            const chosen = post;
            // Where is the author name? Facebook renders it in an h3/h4/strong
            // link above the body.
            const nameEl = document.querySelector('h3 a, h4 a, strong a[role="link"]');
            fbHeaderCheck = {
              chosenTag: chosen?.tagName.toLowerCase(),
              chosenShare: chosen ? shareOf(chosen) : null,
              chosenText: (chosen?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
              nameFound: !!nameEl,
              nameText: (nameEl?.textContent ?? '').trim().slice(0, 40),
              nameInsideChosen: !!(chosen && nameEl && chosen.contains(nameEl)),
              chosenImgs: chosen?.querySelectorAll('img').length ?? 0,
            };
          }
          // Facebook post-card anatomy, measured rather than guessed. Two failed
          // climb heuristics landed on page chrome, both because a SHARED post
          // nests two bylines. So map the real structure: for EVERY story_message
          // on the page, walk up and record each ancestor's box + sibling count +
          // whether it contains the nearest h3/h4 byline and how many bylines it
          // encloses. The right stop condition should be readable from this.
          const fbCards: unknown[] = [];
          for (const sm of Array.from(document.querySelectorAll(
            '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]')).slice(0, 3)) {
            const rows: string[] = [];
            let p: Element | null = sm;
            for (let i = 0; i < 14 && p && p !== document.body; i++) {
              const par: HTMLElement | null = p.parentElement;
              const sig = `${p.tagName.toLowerCase()}|${typeof p.className === 'string' ? p.className.trim() : ''}`;
              const sibs = par ? (Array.from(par.children) as Element[]).filter(c =>
                `${c.tagName.toLowerCase()}|${typeof c.className === 'string' ? c.className.trim() : ''}` === sig).length : 0;
              const r = p.getBoundingClientRect();
              const bylines = p.querySelectorAll('h3 a, h4 a, h2 a, strong a[role="link"]').length;
              const imgs = p.querySelectorAll('img').length;
              const msgs = p.querySelectorAll(
                '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]').length;
              rows.push(`${i}: ${Math.round(r.width)}x${Math.round(r.height)} sibs=${sibs} ` +
                `bylines=${bylines} imgs=${imgs} storyMsgs=${msgs} share=${shareOf(p)}`);
              p = par;
            }
            fbCards.push({
              msgText: (sm.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50),
              chain: rows,
            });
          }
          // TOP-DOWN card location: find the FEED TRACK (the container whose
          // children are the post cards), then ask which child holds a given
          // story_message. Climbing bottom-up cannot find the card boundary
          // (three attempts overshot), but the track's children ARE the cards by
          // construction — so this reports whether that framing works.
          let fbTrack: unknown = null;
          {
            const msgs = Array.from(document.querySelectorAll(
              '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]'));
            // The track = the deepest container that holds 2+ DISTINCT messages
            // in separate children.
            const containers = new Map<Element, Set<Element>>();
            for (const m of msgs) {
              let p: Element | null = m.parentElement;
              while (p && p !== document.body) {
                const set = containers.get(p) ?? new Set<Element>();
                set.add(m);
                containers.set(p, set);
                p = p.parentElement;
              }
            }
            let track: Element | null = null;
            let depth = -1;
            for (const [el, set] of containers) {
              if (set.size < 2) continue;
              let d = 0;
              for (let q: Element | null = el; q; q = q.parentElement) d++;
              if (d > depth) { depth = d; track = el; }
            }
            if (track) {
              const tr = track.getBoundingClientRect();
              const kids = (Array.from(track.children) as Element[]).map(k => {
                const kr = k.getBoundingClientRect();
                return {
                  box: `${Math.round(kr.width)}x${Math.round(kr.height)}`,
                  bylines: k.querySelectorAll('h3 a, h4 a, h2 a, strong a[role="link"]').length,
                  imgs: k.querySelectorAll('img').length,
                  msgs: k.querySelectorAll('[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]').length,
                  text: (k.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 55),
                };
              });
              fbTrack = {
                trackBox: `${Math.round(tr.width)}x${Math.round(tr.height)}`,
                childCount: track.children.length,
                kids: kids.slice(0, 8),
              };
            }
          }
          return {
            url: location.href, vw, vh,
            ancestryFromText, fbHeaderCheck, fbCards, fbTrack,
            bodyTextLen: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
            videos: document.querySelectorAll('video').length,
            candidates: found,
            postAnatomy,
            dataE2e: attrValues('data-e2e'),
            dataPagelet: attrValues('data-pagelet'),
            dataTestid: attrValues('data-testid'),
          };
        });
        lines.push(`\n===== ${name} =====`, JSON.stringify(info, null, 2));
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
  writeFileSync(resolve(OUT, 'social-tagger-probe.txt'), out, 'utf8');
  // eslint-disable-next-line no-console
  console.log(out.slice(0, 6000));
});
