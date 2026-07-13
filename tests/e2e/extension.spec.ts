// Real Chromium with the built Discerned extension loaded. For each fixture
// page, programmatically trigger captureContext() via the dev-mode test bridge
// and assert the returned Capture matches the sidecar.

import { test } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';
import { loadSiteFixtures } from './helpers/loadFixtures';
import { matchExpected } from './helpers/matchExpected';

const fixtures = loadSiteFixtures();

test.describe('extension capture pipeline', () => {
  // NOT serial: each fixture test is independent (own browser context). Serial
  // mode made one failure abort every later fixture — the standing
  // reddit-thread failure was silently skipping 8 fixtures incl. xss-injected.

  for (const fx of fixtures) {
    test(`captures ${fx.htmlName} via extractor "${fx.expected.format}"`, async () => {
      // Some fixtures (goodreads-book: 97 <img> with real CDN srcs) are
      // network-bound — page load + image inlining can exceed the 30s default.
      test.setTimeout(120_000);
      const { ctx } = await launchWithExtension();
      try {
        const page = await ctx.newPage();
        // Surface content-script console.log/error so a failure to inject is visible.
        page.on('console', (msg) => {
          if (msg.text().includes('Discerned')) {
            // eslint-disable-next-line no-console
            console.log(`[browser:${msg.type()}]`, msg.text());
          }
        });
        page.on('pageerror', (err) => {
          // eslint-disable-next-line no-console
          console.log(`[browser:pageerror]`, err.message);
        });
        await page.goto(fx.url, { waitUntil: 'load' });

        // The content script registers its message listener at document_idle.
        // Wait briefly to make sure it's bound before we postMessage.
        await page.waitForTimeout(500);

        const cap = await page.evaluate(async (format) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('capture timeout')), 10_000);
            const onMessage = (e: MessageEvent) => {
              if (e.source !== window) return;
              if (!e.data || typeof e.data !== 'object') return;
              if (e.data.type !== '__DISCERNED_TEST_CAPTURE_RESULT') return;
              clearTimeout(timer);
              window.removeEventListener('message', onMessage);
              if (e.data.error) reject(new Error(String(e.data.error)));
              else resolve(e.data.capture);
            };
            window.addEventListener('message', onMessage);
            window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format }, window.location.origin);
          });
        }, fx.expected.format);

        matchExpected(cap as Parameters<typeof matchExpected>[0], fx.expected);
      } finally {
        await ctx.close();
      }
    });
  }
});
