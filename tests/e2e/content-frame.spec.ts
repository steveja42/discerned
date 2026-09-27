// A live blog rendered in an <iframe> (ESPN's Arena tracker) must reach the clip:
// the frame body replaces the iframe, its tweets become cards, and the empty
// ad-slot <article> before the story must not hand capture to the layout finder
// (which took the whole page, NFL scores strip included). Same-origin frame, so
// activeTab alone covers the injection — no permission grant involved.

import { test, expect, type BrowserContext } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';

const URL = 'http://127.0.0.1:4173/liveblog-iframe.html';

async function capture(ctx: BrowserContext, format: 'article' | 'full-page'): Promise<string> {
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await activateExtensionOnTab(ctx, URL);
  const cap = await page.evaluate((format) => new Promise<{ bodyHtml?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture timeout')), 15_000);
    const on = (e: MessageEvent) => {
      if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
      clearTimeout(timer); removeEventListener('message', on);
      resolve(e.data.capture ?? {});
    };
    addEventListener('message', on);
    postMessage({ type: '__DISCERNED_TEST_CAPTURE', format }, location.origin);
  }), format);
  await page.close();
  return cap.bodyHtml ?? '';
}

test('inlines a live-blog iframe and skips the empty ad-slot <article>', async () => {
  test.setTimeout(60_000);
  const { ctx } = await launchWithExtension();
  try {
    const html = await capture(ctx, 'article');
    expect(html).toContain('legal negotiation window');
    expect(html, 'scores strip outside the <article>').not.toContain('ATL 35');
    expect(html, 'frame entries inlined').toContain('Chiefs sign Kenneth Walker III');
    expect(html).toContain('Vikings land Kyler Murray');
    expect(html, 'hidden frame markup dropped').not.toContain('HIDDEN-SENTINEL');
    expect(html, 'frame tweet carded').toContain('tweet-card');
    expect(html).not.toContain('<iframe');
  } finally {
    await ctx.close();
  }
});

test('full-page drops a ticker strip (short, clipped, track far wider than its box)', async () => {
  test.setTimeout(60_000);
  const { ctx } = await launchWithExtension();
  try {
    const html = await capture(ctx, 'full-page');
    expect(html, 'full-page keeps the story').toContain('legal negotiation window');
    expect(html, 'scores ticker dropped').not.toContain('ATL 35');
    expect(html, 'frame entries inlined in full-page too').toContain('Chiefs sign Kenneth Walker III');
  } finally {
    await ctx.close();
  }
});
