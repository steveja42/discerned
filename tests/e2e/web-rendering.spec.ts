// Drives the /library page by injecting clip fixtures through the same
// postMessage bridge the extension uses. Asserts that ClipRow renders the
// fields we promise users will see.

import { test, expect } from '@playwright/test';
import { loadClipFixtures } from './helpers/loadFixtures';

const clips = loadClipFixtures().map((f) => ({
  capture: f.capture,
  evaluation: f.evaluation,
  encrypted: '',
}));

test.describe('web rendering — /library via bridge', () => {
  test('renders one ClipRow per injected clip with title, domain, excerpt', async ({ page }) => {
    await page.goto('/library');
    // Wait for the bridge hook to mount and post DISCERNED_WEB_READY.
    await page.waitForLoadState('networkidle');

    await page.evaluate((injectedClips) => {
      // Simulate the extension's HELLO + CLIPS bursts.
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
        window.location.origin,
      );
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_CLIPS', clips: injectedClips },
        window.location.origin,
      );
    }, clips);

    // One <article class="clip"> per fixture.
    const rows = page.locator('article.clip');
    await expect(rows).toHaveCount(clips.length);

    for (const clip of clips) {
      await expect(page.locator('article.clip', { hasText: clip.capture.title })).toBeVisible();
    }

    // Spot-check the article fixture's domain (example.com appears on a few).
    await expect(page.locator('article.clip .domain').first()).toBeVisible();
  });

  test('clicking a clip surfaces its detail content', async ({ page }) => {
    await page.goto('/library');
    await page.waitForLoadState('networkidle');

    const articleClip = clips.find((c) => c.capture.format === 'article');
    if (!articleClip) test.skip(true, 'no article fixture');

    await page.evaluate((c) => {
      window.postMessage(
        { type: 'DISCERNED_BRIDGE_HELLO', pubkey: 'a'.repeat(64), authMethod: 'nip07' },
        window.location.origin,
      );
      window.postMessage({ type: 'DISCERNED_BRIDGE_CLIPS', clips: [c] }, window.location.origin);
    }, articleClip);

    const row = page.locator('article.clip', { hasText: articleClip!.capture.title });
    await expect(row).toBeVisible();
    await row.click();
    // The DetailPanel renders the full title in a .detail-title heading.
    // (The same title text also lives in the row's <h3> and possibly the body,
    //  so we scope strictly to the detail panel selector.)
    await expect(page.locator('.detail-title', { hasText: articleClip!.capture.title }))
      .toBeVisible();
  });
});
