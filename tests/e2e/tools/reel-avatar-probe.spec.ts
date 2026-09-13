// Does the Instagram reel avatar overlap the username, and does the media lead?
//
// Both are CSS/order questions about .clip-body, so they are MEASURED by
// rendering captured markup through the REAL app stylesheet rather than
// reasoned about from the cascade — reasoning about it picked the wrong rule
// once already.
//
// Run:  REELAV=1 REELAV_HTML=<file> pnpm exec playwright test \
//         -c tests/e2e/playwright.config.ts --project=reel-avatar-probe

import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

test('reel avatar vs username geometry', async () => {
  test.skip(!process.env.REELAV, 'set REELAV=1 to run');
  test.setTimeout(120_000);

  const bodyHtml = readFileSync(process.env.REELAV_HTML!, 'utf8');
  const browser = await chromium.launch({ headless: true });
  const vw = parseInt(process.env.REELAV_VW ?? '1280', 10);
  const vh = parseInt(process.env.REELAV_VH ?? '900', 10);
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  try {
    await page.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await page.evaluate((html: string) => {
      const host = document.createElement('div');
      host.className = 'clip-body';
      host.innerHTML = html;
      document.body.innerHTML = '';
      document.body.appendChild(host);
    }, bodyHtml);
    await page.waitForTimeout(800);
    if (process.env.REELAV_PLAY) {
      await page.evaluate(() => {
        const card = document.querySelector('a.tweet-video') as HTMLElement | null;
        card?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      });
      await page.waitForTimeout(1200);
    }

    const r = await page.evaluate(() => {
      const q = <T extends HTMLElement>(s: string) => document.querySelector(s) as T | null;
      const av = q('img.dx-avatar');
      const name = (Array.from(document.querySelectorAll('.dx-header a')) as HTMLElement[])
        .find(a => !a.querySelector('img.dx-avatar') && (a.textContent||'').trim().length > 0) ?? null;
      const hdr = q('.dx-header'), media = q('.dx-reel-media');
      const b = (e: HTMLElement | null) => e ? e.getBoundingClientRect() : null;
      const a = b(av), n = b(name), m = b(media), h = b(hdr);
      const cs = (e: HTMLElement | null) => e ? getComputedStyle(e) : null;
      return {
        avatar: a && { l: Math.round(a.left), r: Math.round(a.right), t: Math.round(a.top) },
        name: n && { l: Math.round(n.left), t: Math.round(n.top) },
        // >0 means the avatar's right edge is past the username's left edge.
        overlapPx: a && n ? Math.round(a.right - n.left) : null,
        headerDisplay: cs(hdr)?.display,
        avatarDisplay: cs(av)?.display,
        avatarFloat: cs(av)?.float,
        avatarMarginRight: cs(av)?.marginRight,
        nameParentTag: name?.parentElement?.tagName,
        avatarParentTag: av?.parentElement?.tagName,
        sameFlexChild: (() => {
          if (!av || !name || !hdr) return null;
          const childOf = (e: HTMLElement) => { let c: HTMLElement = e; while (c.parentElement && c.parentElement !== hdr) c = c.parentElement; return c; };
          return childOf(av) === childOf(name);
        })(),
        grid: (() => {
          const g = document.querySelector('.dx-reel') as HTMLElement | null;
          if (!g) return null;
          const gb = g.getBoundingClientRect();
          const cell = (sel: string) => {
            const e = document.querySelector(sel) as HTMLElement | null;
            if (!e) return null;
            const r = e.getBoundingClientRect();
            return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
          };
          const poster = document.querySelector('.dx-reel-media img') as HTMLElement | null;
          const pr = poster?.getBoundingClientRect();
          return {
            cols: getComputedStyle(g).gridTemplateColumns,
            reel: { l: Math.round(gb.left), r: Math.round(gb.right), w: Math.round(gb.width) },
            caption: cell('.dx-reel-caption'),
            media: cell('.dx-reel-media'),
            rail: cell('.dx-reel-rail'),
            poster: pr ? { l: Math.round(pr.left), r: Math.round(pr.right), w: Math.round(pr.width) } : null,
            frame: (() => {
              const f = document.querySelector('.clip-video-frame') as HTMLElement | null;
              if (!f) return null;
              const fr = f.getBoundingClientRect();
              const wrap = f.parentElement as HTMLElement | null;
              const wr = wrap?.getBoundingClientRect();
              return {
                l: Math.round(fr.left), w: Math.round(fr.width), h: Math.round(fr.height),
                visibleH: wr ? Math.round(wr.height) : null,
                wrapClass: wrap?.className || '-',
                wrapW: wr ? Math.round(wr.width) : null,
                wrapMaxW: wrap ? getComputedStyle(wrap).maxWidth : null,
              };
            })(),
          };
        })(),
        headerBox: h && { l: Math.round(h.left), r: Math.round(h.right), w: Math.round(h.width) },
        flexChildren: hdr ? Array.from(hdr.children).map(c => {
          const cb = c.getBoundingClientRect(); const st = getComputedStyle(c as HTMLElement);
          return `${c.tagName}.${(c as HTMLElement).className||'-'} l=${Math.round(cb.left)} w=${Math.round(cb.width)} disp=${st.display} dir=${st.flexDirection}`;
        }) : null,
        avatarComputedMR: cs(av)?.marginRight,
        avatarWidth: av ? Math.round(av.getBoundingClientRect().width) : null,
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        mediaTop: m ? Math.round(m.top) : null,
        headerTop: h ? Math.round(h.top) : null,
      };
    });
    console.log('REEL_PROBE ' + JSON.stringify(r, null, 2));
    const shotDir = 'test-output';
    const name = (process.env.REELAV_NAME ?? 'reel-avatar');
    const hdrEl = page.locator('.dx-header').first();
    if (await hdrEl.count()) {
      await hdrEl.screenshot({ path: `${shotDir}/${name}-header.png` }).catch(() => undefined);
    }
    await page.locator('.clip-body').first()
      .screenshot({ path: `${shotDir}/${name}-body.png` }).catch(() => undefined);
    console.log('REEL_SHOT ' + `${shotDir}/${name}-header.png`);
  } finally {
    await browser.close();
  }
});
