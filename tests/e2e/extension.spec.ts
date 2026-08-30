// Real Chromium with the built Discerned extension loaded. For each fixture
// page, programmatically trigger captureContext() via the dev-mode test bridge
// and assert the returned Capture matches the sidecar.

import { test } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';
import { activateExtensionOnTab } from './helpers/activateExtension';
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

        // The content script is injected on the activation gesture (there is no
        // static content_scripts entry), so trigger it and wait for the listener
        // to bind before postMessage-ing the test bridge.
        await activateExtensionOnTab(ctx, fx.url);

        const cap = await page.evaluate(async ({ format, hostOverride }) => {
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
            // hostOverride (when set in the sidecar) fires the real per-site
            // tagger against the 127.0.0.1-served fixture — taggers otherwise
            // gate on window.location.hostname (= 127.0.0.1 here) and never run.
            window.postMessage({ type: '__DISCERNED_TEST_CAPTURE', format, hostOverride }, window.location.origin);
          });
        }, { format: fx.expected.format, hostOverride: fx.hostOverride });

        // fx.url is the local fixture-server URL the page was actually served
        // from — not the sidecar's `url`, which is the location to simulate.
        matchExpected(cap as Parameters<typeof matchExpected>[0], fx.expected, fx.url);
      } finally {
        await ctx.close();
      }
    });
  }
});
