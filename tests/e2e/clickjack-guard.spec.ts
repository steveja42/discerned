// Regression guard for the overlay click-jacking defence.
//
// Some ad-funded pages register a capture-phase click listener on document that
// calls window.open() for ANY click — including clicks inside the Discerned
// overlay. nip07-bridge.ts (MAIN world) neutralises this by overriding
// window.open while the overlay is present.
//
// This became load-bearing when the content scripts moved from static <all_urls>
// injection to on-demand chrome.scripting.executeScript: the bridge and the
// content script are now two separate injections, and if the overlay renders
// before the bridge lands there is a window where overlay clicks open tabs.
// background.ts therefore awaits the bridge injection BEFORE injecting
// content.ts. This spec fails if that ordering is ever reversed.
//
// Run with: CLICKJACK=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=extension

import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';
import { openOverlayOnTab } from './helpers/activateExtension';

const FIXTURE_URL = 'http://127.0.0.1:4173/clickjack-window-open.html';

declare global {
  interface Window { __popupAttempts?: { suppressed: boolean }[] }
}

test.describe.configure({ mode: 'serial' });

test('overlay clicks do not trigger the page\'s window.open hijack', async () => {
  test.setTimeout(120_000);

  const { ctx } = await launchWithExtension({ headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'load', timeout: 30_000 });

    // Sanity check the fixture itself: without the overlay present the guard
    // stands down, so a page click really does open a tab. If this ever reports
    // suppressed:true the fixture has stopped reproducing the hazard and the
    // rest of the assertions below would pass vacuously.
    await page.locator('h1').click();
    const beforeOverlay = await page.evaluate(() => window.__popupAttempts ?? []);
    expect(beforeOverlay.length, 'fixture should attempt a popup on a page click').toBe(1);
    expect(
      beforeOverlay[0].suppressed,
      'with no overlay present the page popup should NOT be suppressed',
    ).toBe(false);

    // Open the overlay through the real activation path (inject bridge, then
    // content script, then ACTIVATE_DISCERNED) — the same function the toolbar
    // click handler runs.
    await openOverlayOnTab(ctx, FIXTURE_URL);
    const host = page.locator('#discerned-overlay');
    await expect(host).toBeAttached({ timeout: 15_000 });

    // Click inside the overlay PANEL (not just the full-viewport host: the panel
    // is a ~380px strip, and clicking bare host area is an "outside" click that
    // dismisses the overlay). The panel lives in a closed shadow root, so its
    // box comes from the host's first element child via elementFromPoint-free
    // geometry: probe the host's own rect and aim at the left strip where the
    // panel is docked.
    await expect
      .poll(async () => (await host.boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(100);
    const box = (await host.boundingBox())!;
    // Panel is left-docked and 380px wide; aim well inside it.
    await page.mouse.click(box.x + 150, box.y + box.height / 2);

    // The overlay must survive its own click — if it closed, this was an
    // outside click and the assertions below would be meaningless.
    await expect(host).toBeAttached();

    // Assert the GUARD IS INSTALLED, not merely that no tab opened.
    //
    // window.open returning null is ambiguous: Chrome's own popup blocker also
    // returns null for a call it considers not user-initiated, so an outcome-only
    // assertion passes even with the bridge removed entirely (verified — it did).
    // The unambiguous signal is that window.open is no longer the native
    // function: our override is a distinct closure, so Function.prototype
    // .toString() on it does not report [native code].
    //
    // Read this in the MAIN world (the page's own window), where the bridge
    // installs the override — the isolated content-script world has its own.
    const guard = await page.evaluate(() => ({
      overridden: !/\[native code\]/.test(String(window.open)),
      overlayPresent: !!document.querySelector('#discerned-overlay'),
    }));

    expect(
      guard.overlayPresent,
      'overlay should still be open — a dismissed overlay disarms the guard',
    ).toBe(true);
    expect(
      guard.overridden,
      'window.open is still native — nip07-bridge.ts was not injected, so a page '
      + 'that opens tabs on click would hijack overlay clicks',
    ).toBe(true);

    // And the behavioural check: nothing the page attempted actually opened.
    const afterOverlay = await page.evaluate(() => window.__popupAttempts ?? []);
    for (const attempt of afterOverlay.slice(1)) {
      expect(attempt.suppressed, 'a click inside the overlay opened a tab').toBe(true);
    }
  } finally {
    await ctx.close();
  }
});
