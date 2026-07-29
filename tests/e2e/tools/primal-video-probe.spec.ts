// Diagnostic: why a primal.net note's video poster is missing from the capture.
//
// Dumps the LIVE video/player DOM (media-controller shadow roots included),
// then runs the real capture and reports what survived into bodyHtml.
//
// Run: PVID=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//   tests/e2e/tools/primal-video-probe.spec.ts

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL_ =
  process.env.PVID_URL ||
  'https://primal.net/e/nevent1qqsxc60edsxhketnyhenkwnckgj9ggv83gaeue42q8amycf2d5vhzfg32akzs';

test('primal video poster probe', async () => {
  test.skip(!process.env.PVID, 'set PVID=1 to run this');
  test.setTimeout(180_000);

  const outDir = resolve(__dirname, '..', '..', '..', 'test-output');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = (n: string) => resolve(outDir, n);

  const { ctx } = await launchWithExtension({ headed: !!process.env.PVID_HEADED });
  try {
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.text().includes('Discerned')) console.log(`[browser:${m.type()}]`, m.text());
    });
    await page.goto(URL_, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(6_000);

    // Video players on primal may only hydrate when scrolled into view.
    // Scroll through the note before probing so lazy players mount.
    await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let y = 0; y < 4000; y += 400) {
        window.scrollTo(0, y);
        await sleep(150);
      }
      window.scrollTo(0, 0);
      await sleep(500);
    });
    await page.waitForTimeout(3_000);

    // ── Live DOM report ────────────────────────────────────────────────────
    const report = await page.evaluate(() => {
      const lines: string[] = [];
      const desc = (el: Element) => {
        const a = Array.from(el.attributes)
          .map((x) => `${x.name}="${x.value.slice(0, 90)}"`)
          .join(' ');
        return `<${el.tagName.toLowerCase()} ${a}>`;
      };

      const videos = Array.from(document.querySelectorAll('video'));
      lines.push(`=== <video> count: ${videos.length} ===`);
      for (const v of videos as HTMLVideoElement[]) {
        lines.push(desc(v));
        lines.push(
          `   readyState=${v.readyState} videoWidth=${v.videoWidth} videoHeight=${v.videoHeight} ` +
            `currentTime=${v.currentTime} paused=${v.paused} poster="${v.getAttribute('poster') ?? '(none)'}" ` +
            `src="${(v.getAttribute('src') ?? '').slice(0, 120)}"`,
        );
        const sources = Array.from(v.querySelectorAll('source')).map((s) => s.getAttribute('src'));
        lines.push(`   sources: ${JSON.stringify(sources)}`);
        // Ancestors up to 6 levels
        let cur: Element | null = v.parentElement;
        for (let i = 0; i < 6 && cur; i++) {
          lines.push(`   ancestor[${i}] ${desc(cur).slice(0, 220)}`);
          cur = cur.parentElement;
        }
      }

      const mcs = Array.from(document.querySelectorAll('media-controller'));
      lines.push(`\n=== <media-controller> count: ${mcs.length} ===`);
      for (const mc of mcs) {
        lines.push(desc(mc).slice(0, 400));
        lines.push(`   shadowRoot: ${mc.shadowRoot ? 'OPEN' : 'null/closed'}`);
        if (mc.shadowRoot) {
          lines.push(`   shadow html (500): ${mc.shadowRoot.innerHTML.slice(0, 500)}`);
        }
        // Poster-image custom element used by Media Chrome
        const pi = mc.querySelector('media-poster-image');
        lines.push(`   media-poster-image: ${pi ? desc(pi).slice(0, 250) : '(none)'}`);
        if (pi?.shadowRoot) lines.push(`     its shadow: ${pi.shadowRoot.innerHTML.slice(0, 300)}`);
      }

      // Anything with a background-image inside a note
      const bg = Array.from(document.querySelectorAll<HTMLElement>('[style*="background-image"]'))
        .slice(0, 10)
        .map((el) => `${el.tagName.toLowerCase()} :: ${el.style.backgroundImage.slice(0, 150)}`);
      lines.push(`\n=== background-image elements (first 10) ===\n${bg.join('\n')}`);

      // All imgs whose src looks like a video thumbnail
      const imgs = Array.from(document.querySelectorAll('img'))
        .map((i) => i.getAttribute('src') ?? '')
        .filter((s) => /thumb|poster|video|\.jpg|\.png|\.webp/i.test(s))
        .slice(0, 20);
      lines.push(`\n=== candidate thumbnail <img> srcs ===\n${imgs.join('\n')}`);

      // Full structure of the PRIMARY note, so we can see how the video block
      // is represented before/without hydration.
      const primary = document.querySelector('[class*="_primaryNote_"]');
      lines.push(`\n=== primary note found: ${!!primary} ===`);
      if (primary) {
        const walk = (el: Element, d: number): string => {
          if (d > 9) return `${'  '.repeat(d)}…`;
          const cls = (el.getAttribute('class') ?? '').slice(0, 70);
          const extra: string[] = [];
          for (const n of ['src', 'href', 'data-url', 'data-src', 'poster', 'style', 'type']) {
            const v = el.getAttribute(n);
            if (v) extra.push(`${n}="${v.slice(0, 100)}"`);
          }
          const own = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => (n.textContent ?? '').trim())
            .join(' ')
            .slice(0, 60);
          let s = `${'  '.repeat(d)}<${el.tagName.toLowerCase()} class="${cls}" ${extra.join(' ')}>${own ? ` :: "${own}"` : ''}`;
          for (const c of Array.from(el.children).slice(0, 14)) s += '\n' + walk(c, d + 1);
          return s;
        };
        lines.push(walk(primary, 0));
      }

      // Any element whose class/attrs mention video
      const vidish = Array.from(document.querySelectorAll('*'))
        .filter((el) => /video/i.test(el.getAttribute('class') ?? '') || el.hasAttribute('data-video'))
        .slice(0, 25)
        .map((el) => desc(el).slice(0, 220));
      lines.push(`\n=== elements with "video" in class ===\n${vidish.join('\n')}`);

      return lines.join('\n');
    });
    fs.writeFileSync(out('primal-video-live.txt'), report, 'utf8');
    console.log(report.slice(0, 6000));

    // ── Run the real capture ───────────────────────────────────────────────
    const cap = (await page.evaluate(async () => {
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('capture timeout')), 60_000);
        const onMsg = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
          clearTimeout(t);
          window.removeEventListener('message', onMsg);
          if (e.data.error) rej(new Error(e.data.error));
          else res(e.data.capture);
        };
        window.addEventListener('message', onMsg);
        window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format: 'article' }, window.location.origin);
      });
    })) as { bodyHtml?: string };

    const body = cap.bodyHtml ?? '';
    const stripped = body.replace(/data:image\/[^"'\s]+/g, (m) => `data:image/...(${m.length}b)...`);
    fs.writeFileSync(out('primal-video-capture.html'), stripped, 'utf8');

    const summary = [
      `bodyHtml length: ${body.length}`,
      `<img> count: ${(body.match(/<img/g) ?? []).length}`,
      `data: URIs: ${(body.match(/data:image\//g) ?? []).length}`,
      `dx-video-link count: ${(body.match(/dx-video-link/g) ?? []).length}`,
      `<video> left: ${(body.match(/<video/g) ?? []).length}`,
      `media-controller left: ${(body.match(/media-controller/g) ?? []).length}`,
    ].join('\n');
    fs.writeFileSync(out('primal-video-summary.txt'), summary, 'utf8');
    console.log('\n=== CAPTURE SUMMARY ===\n' + summary);
  } finally {
    await ctx.close();
  }
});
