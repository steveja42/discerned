// Diagnostic: geometry of the .tweet-video poster card as rendered by the real
// .clip-body CSS. Answers why the play overlay sits BELOW the poster instead of
// centered over it (misplaced absolute box) on a YouTube-embed clip.
//
// Run: VCG=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//   --project=video-card-geom-probe

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

test('video card geometry probe', async () => {
  test.skip(!process.env.VCG, 'set VCG=1 to run this');
  test.setTimeout(120_000);

  const outDir = resolve(__dirname, '..', '..', '..', 'test-output');
  const fs = await import('node:fs');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });

    // Inject a minimal clip whose body is prose + our video card, matching the
    // exact shape substituteVideoEmbeds emits on primal.
    const bodyHtml = `<div><div>RIP  <a class="tweet-video" href="https://www.youtube.com/watch?v=OSW2zeM3yLU"><img src="https://i.ytimg.com/vi/OSW2zeM3yLU/hqdefault.jpg" alt="YouTube video thumbnail" class="tweet-video-poster"><div class="tweet-video-play" aria-label="Play video"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M8 5v14l11-7z"></path></svg></div></a></div></div>`;

    await page.evaluate((html) => {
      const clip = {
        capture: {
          format: 'article',
          url: 'https://primal.net/e/test',
          title: 'video card geom',
          bodyHtml: html,
          bodyText: 'RIP',
          capturedAt: Date.now(),
        },
        evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' },
        encrypted: '',
      };
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
        window.location.origin,
      );
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, bodyHtml);

    const row = page.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    const clipBody = page.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1500);

    const geom = await clipBody.evaluate((root) => {
      const pick = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          cls: el.className,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display,
          position: cs.position,
          inset: `${cs.top} ${cs.right} ${cs.bottom} ${cs.left}`,
          textDecoration: cs.textDecorationLine,
          verticalAlign: cs.verticalAlign,
          lineHeight: cs.lineHeight,
          background: cs.backgroundColor,
        };
      };
      return {
        card: pick(root.querySelector('.tweet-video')),
        poster: pick(root.querySelector('.tweet-video-poster')),
        play: pick(root.querySelector('.tweet-video-play')),
        parent: pick(root.querySelector('.tweet-video')?.parentElement ?? null),
      };
    });

    const txt = JSON.stringify(geom, null, 2);
    fs.writeFileSync(resolve(outDir, 'video-card-geom.json'), txt, 'utf8');
    console.log(txt);

    await clipBody.screenshot({ path: resolve(outDir, 'video-card-geom.png') });
  } finally {
    await browser.close();
  }
});
