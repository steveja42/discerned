// The headline test: extension clips a real fixture page, stores it via the
// real CLIP code path (background → IndexedDB), then the web app pulls it
// through the real postMessage bridge content script on /clips.

import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';

test.describe('end-to-end clip pipeline', () => {
  test.describe.configure({ mode: 'serial' });

  test('captures blog-post.html and renders it on /clips', async () => {
    const { ctx } = await launchWithExtension();
    try {
      // 1. Open the fixture, capture, and CLIP through the real background handler.
      const fixtureUrl = 'http://127.0.0.1:4173/blog-post.html';
      const page = await ctx.newPage();
      await page.goto(fixtureUrl, { waitUntil: 'load' });
      // The content script is injected on the activation gesture (there is no
      // static content_scripts entry), so trigger it before the test bridge.
      await activateExtensionOnTab(ctx, fixtureUrl);

      const capture = await page.evaluate(() => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('capture timeout')), 10_000);
          const onMessage = (e: MessageEvent) => {
            if (e.source !== window) return;
            if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            if (e.data.error) reject(new Error(e.data.error));
            else resolve(e.data.capture);
          };
          window.addEventListener('message', onMessage);
          window.postMessage(
            { type: '__DISCERNED_TEST_CAPTURE', format: 'article' },
            window.location.origin,
          );
        });
      });

      expect(capture).toMatchObject({ format: 'article', url: fixtureUrl });

      // 2. Drive the real CLIP path. Background writes IndexedDB and pushes
      //    DISCERNED_BRIDGE_NEW_CLIP to any open discerned.online tab.
      const clipResult = await page.evaluate((cap) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('clip timeout')), 10_000);
          const onMessage = (e: MessageEvent) => {
            if (e.source !== window) return;
            if (e.data?.type !== '__DISCERNED_TEST_CLIP_RESULT') return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            if (e.data.error) reject(new Error(e.data.error));
            else resolve(e.data.result);
          };
          window.addEventListener('message', onMessage);
          window.postMessage(
            {
              type: '__DISCERNED_TEST_CLIP',
              capture: cap,
              evaluation: { signal: 'Worthwhile', qualifiers: ['Primary Source'], category: 'Philosophy' },
            },
            window.location.origin,
          );
        });
      }, capture);

      expect(clipResult).toMatchObject({ success: true });

      // 3. Open the web app's /clips — the bridge content script runs there
      //    because manifest.json includes http://localhost:3000/*. It will fetch
      //    the stored clips from IndexedDB and post DISCERNED_BRIDGE_CLIPS.
      //
      //    Race condition: the bridge posts DISCERNED_BRIDGE_CLIPS once after a
      //    200ms proactive timer OR on DISCERNED_WEB_READY. The web-app listener
      //    rejects DISCERNED_WEB_READY for the same isolated-world reason our
      //    dev hook hit, so production effectively always uses the 200ms timer.
      //    If React hasn't mounted its useLibraryBridge listener by then, the
      //    clip message is delivered to nobody. Reload until it sticks.
      const libraryPage = await ctx.newPage();
      const captureObj = capture as { title: string };
      const row = libraryPage.locator('article.clip', { hasText: captureObj.title }).first();

      let visible = false;
      for (let attempt = 0; attempt < 4 && !visible; attempt++) {
        await libraryPage.goto('http://localhost:3000/clips', { waitUntil: 'load' });
        try {
          await row.waitFor({ state: 'visible', timeout: 5_000 });
          visible = true;
        } catch {
          // Bridge race — reload and try again.
        }
      }
      await expect(row).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
