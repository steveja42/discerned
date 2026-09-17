// Does an emoji served as an IMAGE render inline (text-size) in the clip AND
// the cast, rather than as a paragraph-sized block?
//
// X serves emoji either as Unicode text or as a Twemoji <img> depending on the
// render path, and the live page happened to serve text — so this drives the
// IMAGE case directly, using the exact markup reported:
//   <img alt="🇺🇸" src="https://abs.twimg.com/emoji/v2/svg/1f1fa-1f1f8.svg">
// It reports the computed size of each emoji image on both surfaces beside the
// surrounding font-size, which is the comparison that matters: an emoji should
// be about one line tall, not 400px.
//
// Run: EMOJIR=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=emoji-render-probe

import { test } from '@playwright/test';
import { chromium } from '@playwright/test';

const FLAG = 'https://abs.twimg.com/emoji/v2/svg/1f1fa-1f1f8.svg';
const EYES = 'https://abs.twimg.com/emoji/v2/svg/1f440.svg';

// A capture shaped like a real tweet clip whose body text carries emoji images.
const BODY_HTML = `<div class="tweet-card tweet-card--native">
  <div class="tweet-header"><div class="tweet-author">
    <span class="tweet-name">Bitcoin Magazine</span>
    <span class="tweet-handle">@BitcoinMagazine</span>
  </div></div>
  <div class="tweet-text">JUST IN: <img alt="🇺🇸" class="dx-emoji" width="16" height="16" src="${FLAG}"> SEC Chairman speaks <img alt="👀" class="dx-emoji" width="16" height="16" src="${EYES}"></div>
</div>`;

const MARKDOWN = `**Bitcoin Magazine** @BitcoinMagazine

JUST IN: ![🇺🇸](${FLAG}) SEC Chairman speaks ![👀](${EYES})

![Image](https://pbs.twimg.com/media/HSWhWhMXQAAhHqN?format=webp&name=medium)`;

test('emoji-render-probe', async () => {
  test.skip(!process.env.EMOJIR, 'set EMOJIR=1 to run');
  test.setTimeout(180_000);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    // --- CLIP surface
    await page.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await page.evaluate((html) => {
      const capture = {
        id: 'emoji-probe', url: 'https://x.com/BitcoinMagazine/status/1',
        title: 'Emoji probe', timestamp: Date.now(), format: 'article',
        bodyHtml: html, bodyText: 'JUST IN: SEC Chairman speaks',
      };
      const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, BODY_HTML);
    await page.locator('article.clip').first().click({ timeout: 15_000 });
    const body = page.locator('.clip-body');
    await body.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(1500);

    const measure = async () => page.evaluate(() => {
      const root = document.querySelector('.clip-body');
      if (!root) return { fontSize: '?', imgs: [] as Array<Record<string, string>> };
      const host = root.querySelector('.tweet-text') ?? root.querySelector('p') ?? root;
      return {
        fontSize: getComputedStyle(host as Element).fontSize,
        imgs: Array.from(root.querySelectorAll('img')).map((im) => {
          const r = im.getBoundingClientRect();
          const cs = getComputedStyle(im);
          return {
            alt: im.getAttribute('alt') ?? '', cls: im.className || '(none)',
            rendered: `${Math.round(r.width)}x${Math.round(r.height)}`,
            display: cs.display,
          };
        }),
      };
    });

    const clip = await measure();
    // eslint-disable-next-line no-console
    console.log(`\n[CLIP] surrounding font-size: ${clip.fontSize}`);
    clip.imgs.forEach(i => console.log(`[CLIP]   alt="${i.alt}" class=${i.cls} rendered=${i.rendered} display=${i.display}`));
    await page.screenshot({ path: 'test-output/emoji-clip.png', fullPage: false });

    // --- CAST surface: same emoji, but as markdown.
    await page.goto('http://localhost:3000/clips', { waitUntil: 'networkidle' });
    await page.evaluate((md) => {
      const capture = {
        id: 'emoji-probe-cast', url: 'https://x.com/BitcoinMagazine/status/2',
        title: 'Emoji probe cast', timestamp: Date.now(), format: 'article',
        markdown: md, bodyText: 'cast',
      };
      const clip = { capture, evaluation: { signal: 'Worthwhile', qualifiers: [], category: 'General' }, encrypted: '' };
      window.postMessage({ type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' }, window.location.origin);
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [clip] }, window.location.origin);
    }, MARKDOWN);
    await page.locator('article.clip').first().click({ timeout: 15_000 });
    await page.locator('.clip-body').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(1500);
    const cast = await measure();
    // eslint-disable-next-line no-console
    console.log(`\n[CAST-ish] surrounding font-size: ${cast.fontSize}`);
    cast.imgs.forEach(i => console.log(`[CAST-ish]   alt="${i.alt}" class=${i.cls} rendered=${i.rendered} display=${i.display}`));
    await page.screenshot({ path: 'test-output/emoji-cast.png', fullPage: false });
  } finally {
    await browser.close();
  }
});
