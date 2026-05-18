// Opt-in live mode: hits real public URLs and asserts the extractor produces
// sensible captures. Skipped unless LIVE=1 is set.
//
// Run with: pnpm test:live

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from './helpers/launchExtension';

interface LiveUrlSpec {
  url: string;
  format: 'selection' | 'article' | 'full-page' | 'bookmark';
  bodyTextContains: string[];
}

const liveUrls: LiveUrlSpec[] = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'fixtures', 'live-urls.json'), 'utf8'),
);

test.describe('@live extension capture against real URLs', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!process.env.LIVE, 'live mode opt-in only (set LIVE=1)');

  for (const item of liveUrls) {
    test(`@live clips ${item.url}`, async () => {
      const { ctx } = await launchWithExtension();
      try {
        const page = await ctx.newPage();
        await page.goto(item.url, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForTimeout(500);

        const cap = await page.evaluate((format) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('capture timeout')), 20_000);
            const onMessage = (e: MessageEvent) => {
              if (e.source !== window) return;
              if (e.data?.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
              clearTimeout(timer);
              window.removeEventListener('message', onMessage);
              if (e.data.error) reject(new Error(e.data.error));
              else resolve(e.data.capture);
            };
            window.addEventListener('message', onMessage);
            window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format }, window.location.origin);
          });
        }, item.format);

        const c = cap as { format: string; title: string; bodyText?: string };
        expect(c.format).toBe(item.format);
        expect(c.title.length).toBeGreaterThan(0);
        for (const needle of item.bodyTextContains) {
          expect(c.bodyText ?? '').toContain(needle);
        }
      } finally {
        await ctx.close();
      }
    });
  }
});
