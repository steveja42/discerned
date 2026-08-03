// TEMPORARY diagnostic (delete after use): why does the MSN clip drop the hero
// image and pick up "Sponsored Content" text?
import { test } from '@playwright/test';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.MSN_URL
  ?? 'https://www.msn.com/en-us/money/general/astrazeneca-suffers-18bn-hit-over-us-merger-talks/ar-AA29gc1N';

test('msn images + sponsored', async () => {
  const { ctx } = await launchWithExtension({ headed: !!process.env.MSN_HEADED });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  await page.evaluate(async () => {
    for (let y = 0; y < 4000; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 350)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(3000);

  const dom = await page.evaluate(() => {
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const deep: Element[] = [];
    const visit = (root: ParentNode) => {
      root.querySelectorAll('*').forEach(e => {
        deep.push(e);
        const sr = (e as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) visit(sr);
      });
    };
    visit(document.body);

    const path = (el: Element) => {
      const c: string[] = [];
      let cur: Element | null = el;
      for (let i = 0; cur && i < 10; i++) {
        const cls = typeof cur.className === 'string' && cur.className
          ? '.' + cur.className.split(/\s+/).slice(0, 2).join('.') : '';
        c.push(cur.tagName.toLowerCase() + cls + (cur.id ? '#' + cur.id : ''));
        cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
      }
      return c.join(' < ');
    };

    // Every reasonably-sized image on the page, with geometry + where it lives.
    const imgs = deep.filter(e => e.tagName.toLowerCase() === 'img').map(e => {
      const i = e as HTMLImageElement;
      const r = i.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        natural: `${i.naturalWidth}x${i.naturalHeight}`,
        src: (i.currentSrc || i.src || '').slice(0, 95),
        alt: norm(i.alt).slice(0, 40),
        where: path(i).split(' < ').slice(0, 5).join(' < '),
      };
    }).filter(x => x.w > 60 && x.h > 60);

    // Anything mentioning Sponsored, and where it sits.
    const sponsored = deep.filter(e => !e.children.length && /sponsored/i.test(norm(e.textContent)))
      .slice(0, 6).map(e => `"${norm(e.textContent).slice(0, 45)}" @ ${path(e).split(' < ').slice(0, 6).join(' < ')}`);

    return { imgs: imgs.slice(0, 16), imgCount: imgs.length, sponsored };
  });
  // eslint-disable-next-line no-console
  console.log('=== LIVE DOM ===\n' + JSON.stringify(dom, null, 2));

  // Try EVERY article-like format — the user's real clip may not be 'article'.
  for (const fmt of ['article', 'full-page'] as const) {
    const r = await page.evaluate(async (format: string) => new Promise<Record<string, unknown>>((resolve) => {
      const t = setTimeout(() => resolve({ __err: 'timeout' }), 40_000);
      const on = (e: MessageEvent) => {
        if ((e.data as { type?: string })?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); window.removeEventListener('message', on);
        const d = e.data as { error?: string; capture?: Record<string, unknown> };
        resolve(d.error ? { __err: d.error } : (d.capture ?? {}));
      };
      window.addEventListener('message', on);
      window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format }, window.location.origin);
    }), fmt);
    const h = String(r.bodyHtml ?? '');
    const tx = String(r.bodyText ?? '').replace(/\s+/g, ' ');
    const ads = (tx.match(/Sponsored|Insurance|Ditching|Brace Yourself|Cheapest Car/gi) ?? []);
    // eslint-disable-next-line no-console
    console.log(`\n--- format=${fmt}: html=${h.length} imgs=${(h.match(/<img/g) ?? []).length} `
      + `sponsored=${/sponsored/i.test(tx)} adPhrases=${JSON.stringify([...new Set(ads)])}`);
    // eslint-disable-next-line no-console
    console.log('   text:', tx.slice(0, 260));
  }

  const res = await page.evaluate(async () => new Promise<Record<string, unknown>>((resolve) => {
    const t = setTimeout(() => resolve({ __err: 'timeout' }), 40_000);
    const on = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
      clearTimeout(t); window.removeEventListener('message', on);
      const d = e.data as { error?: string; capture?: Record<string, unknown> };
      resolve(d.error ? { __err: d.error } : (d.capture ?? {}));
    };
    window.addEventListener('message', on);
    window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
  }));

  // Where does the hero image sit relative to the text we DID capture?
  const rel = await page.evaluate(() => {
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const deep: Element[] = [];
    const visit = (root: ParentNode) => {
      root.querySelectorAll('*').forEach(e => {
        deep.push(e);
        const sr = (e as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) visit(sr);
      });
    };
    visit(document.body);
    const hero = deep.find(e => e.tagName.toLowerCase() === 'img'
      && /slide-image/.test((e.className || '').toString())) as HTMLImageElement | undefined;
    const kirk = deep.find(e => !e.children.length && /Kirk steps aside/i.test(norm(e.textContent)));
    const chainOf = (el: Element | undefined) => {
      if (!el) return '(not found)';
      const c: string[] = [];
      let cur: Element | null = el;
      for (let i = 0; cur && i < 16; i++) {
        const cls = typeof cur.className === 'string' && cur.className
          ? '.' + cur.className.split(/\s+/).slice(0, 2).join('.') : '';
        c.push(cur.tagName.toLowerCase() + cls + (cur.id ? '#' + cur.id : ''));
        cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
      }
      return c.join('\n     < ');
    };
    // Deepest common ancestor of hero + captured text (crossing shadow roots).
    const ancestors = (el: Element | undefined) => {
      const out: Element[] = [];
      let cur: Element | null = el ?? null;
      while (cur) { out.push(cur); cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host as Element | undefined) ?? null; }
      return out;
    };
    const ha = ancestors(hero), ka = ancestors(kirk);
    const common = ha.find(a => ka.includes(a));
    const label = (e: Element | undefined) => e
      ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(/\s+/).slice(0,2).join('.') : '') + (e.id ? '#' + e.id : '')
      : '(none)';
    // Is the hero hidden / excluded-looking?
    let heroStyle = '(n/a)';
    if (hero) {
      const s = getComputedStyle(hero);
      const r = hero.getBoundingClientRect();
      heroStyle = `display=${s.display} visibility=${s.visibility} opacity=${s.opacity} pos=${s.position} rect=${Math.round(r.width)}x${Math.round(r.height)}`;
      const anc = ancestors(hero).slice(1, 8).map(a => {
        const as = getComputedStyle(a);
        return `${label(a)} [${as.display}/${as.visibility}/${as.position}/op${as.opacity}]`;
      });
      heroStyle += '\n   ancestors: ' + anc.join('\n              ');
    }
    return {
      heroChain: chainOf(hero),
      kirkChain: chainOf(kirk),
      commonAncestor: label(common),
      heroStyle,
    };
  });
  // eslint-disable-next-line no-console
  console.log('\n=== HERO vs CAPTURED TEXT ===');
  // eslint-disable-next-line no-console
  console.log('hero:\n     ' + rel.heroChain);
  // eslint-disable-next-line no-console
  console.log('\ncaptured text node:\n     ' + rel.kirkChain);
  // eslint-disable-next-line no-console
  console.log('\ncommon ancestor:', rel.commonAncestor);
  // eslint-disable-next-line no-console
  console.log('hero style:', rel.heroStyle);

  const html = String(res.bodyHtml ?? '');
  const text = String(res.bodyText ?? '').replace(/\s+/g, ' ');
  const imgTags = html.match(/<img[^>]*>/g) ?? [];

  // CLIP vs CAST divergence: the clip renders the inlined `src` (data: URI);
  // the cast re-derives a real URL from `data-dx-src` / imageUrls. An image that
  // shows in the cast but NOT the clip means inlining failed for that <img>.
  // eslint-disable-next-line no-console
  console.log('\n=== IMG INLINING (clip src vs cast data-dx-src) ===');
  for (const tag of imgTags) {
    const src = /\ssrc="([^"]*)"/.exec(tag)?.[1] ?? '';
    const dx = /data-dx-src="([^"]*)"/.exec(tag)?.[1] ?? '';
    const kind = src.startsWith('data:') ? `INLINED ok (${src.length} chars)`
      : src === '' ? 'EMPTY src'
      : `NOT INLINED → ${src.slice(0, 70)}`;
    // eslint-disable-next-line no-console
    console.log(`  ${kind}\n     cast data-dx-src: ${dx.slice(0, 90) || '(none)'}`);
  }
  // eslint-disable-next-line no-console
  console.log('cast imageUrls:', JSON.stringify(res.imageUrls ?? []).slice(0, 400));
  // eslint-disable-next-line no-console
  console.log('thumbnailUrl (what the CAST shows):', String(res.thumbnailUrl ?? '(none)').slice(0, 120));
  // eslint-disable-next-line no-console
  console.log('thumbnail inlined? :', res.thumbnail ? `yes (${String(res.thumbnail).length} chars)` : 'NO');
  // eslint-disable-next-line no-console
  console.log('og:image on page   :', await page.evaluate(() =>
    document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? '(none)'));
  // eslint-disable-next-line no-console
  console.log('\n=== CAPTURE ===');
  // eslint-disable-next-line no-console
  console.log('bodyHtml len:', html.length, '| <img> count:', imgTags.length);
  // eslint-disable-next-line no-console
  console.log('imgs:', imgTags.map(t => t.slice(0, 110)).join('\n      '));
  // eslint-disable-next-line no-console
  console.log('has "Sponsored"?:', /sponsored/i.test(text));
  // eslint-disable-next-line no-console
  console.log('bodyText:', text.slice(0, 700));
  await ctx.close();
});
