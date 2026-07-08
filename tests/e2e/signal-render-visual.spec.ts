// Opt-in (SIGRENDER=1) screenshot harness: injects the shared clip fixtures
// through the bridge and captures the feed + detail panel so signal stars +
// qualifier chips can be eyeballed. Artifact only — no pixel baseline.

import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadClipFixtures } from './helpers/loadFixtures';

const OUT_DIR = resolve(__dirname, '..', '..', 'test-output');

const clips = loadClipFixtures().map((f) => ({
  capture: f.capture,
  evaluation: f.evaluation,
  encrypted: '',
}));

test.describe('signal render visual', () => {
  test.skip(!process.env.SIGRENDER, 'opt-in: set SIGRENDER=1');

  test('feed + detail show signal stars and qualifier chips', async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true });
    await page.goto('/clips');
    await page.waitForLoadState('networkidle');

    await page.evaluate((injected) => {
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
        window.location.origin,
      );
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: injected }, window.location.origin);
    }, clips);

    await page.locator('article.clip').first().waitFor();
    await page.screenshot({ path: resolve(OUT_DIR, 'signal-feed.png'), fullPage: true });

    // Click a rated clip to open the detail panel.
    const rated = clips.find((c) => c.evaluation.signal);
    if (rated) {
      await page.locator('article.clip', { hasText: rated.capture.title }).first().click();
      await page.locator('.detail-title').waitFor();
      await page.screenshot({ path: resolve(OUT_DIR, 'signal-detail.png') });
    }
  });
});
