// Verifies the relay-preferences round-trip through the REAL extension:
// the web app's settings UI edits the list, the extension's background worker
// persists it to chrome.storage.local (it is the canonical store), and the
// effective set the publisher would use reflects the edit.
//
// The web-only spec (web-relay-settings.spec.ts) covers the UI in isolation;
// this one covers the part only a loaded extension can exercise — that an edit
// actually reaches storage and changes where a cast would be published.

import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';

const CLIPS_URL = 'http://localhost:3000/clips';

test.describe('relay preferences — extension round-trip', () => {
  test.describe.configure({ mode: 'serial' });
  // Launching a persistent context with the extension, plus the bridge
  // handshake retry, runs past the 30s default.
  test.setTimeout(90_000);

  test('an edit in the web settings UI persists to extension storage', async () => {
    const { ctx } = await launchWithExtension();
    try {
      // Test builds default to LOCAL relay mode, where the relay list is
      // deliberately fixed to [LOCAL_RELAY] and editing is disabled. Switch the
      // extension to production first so this exercises the real user path.
      const sw0 = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
      await sw0.evaluate(async () => {
        await chrome.storage.local.set({ relays: 'production' });
      });
      // Written before the page loads, so the bridge's initial push already
      // carries production mode — no broadcast needed.

      const page = await ctx.newPage();
      // The extension opens its onboarding tab on install, which can take focus.
      // Bring our page to the front so clicks land on the settings modal.
      await page.bringToFront();

      // The bridge content script posts the relay list on a 200ms proactive
      // timer; retry the load until the UI has rows (same race the end-to-end
      // spec documents).
      let rowsReady = false;
      for (let attempt = 0; attempt < 4 && !rowsReady; attempt++) {
        await page.goto(CLIPS_URL, { waitUntil: 'load' });
        await page.bringToFront();
        await page.locator('button[title="Settings"]').click();
        try {
          await page.locator('.relay-row').first().waitFor({ state: 'visible', timeout: 5_000 });
          rowsReady = true;
        } catch {
          // Bridge race — reload and retry.
        }
      }
      expect(rowsReady).toBe(true);

      // Add a relay and remove a built-in default in the real UI.
      await page.locator('.relay-add input').fill('wss://relay.e2e-test.example');
      await page.locator('.relay-add button').click();
      await expect(page.locator('.relay-row', { hasText: 'relay.e2e-test.example' })).toBeVisible();

      await page.locator('.relay-row', { hasText: 'wss://nos.lol' })
        .locator('.relay-remove').click();
      await expect(page.locator('.relay-row', { hasText: 'wss://nos.lol' })).toHaveCount(0);

      // Give the postMessage → content script → background hop time to land.
      await page.waitForTimeout(1000);

      // Read what the EXTENSION actually stored, from the extension's own
      // context (the page cannot see chrome.storage).
      const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
      const stored = await sw.evaluate(async () => {
        const s = await chrome.storage.local.get(['userRelays', 'removedRelays']);
        return {
          user: (s.userRelays as string[] | undefined) ?? [],
          removed: (s.removedRelays as string[] | undefined) ?? [],
        };
      });

      expect(stored.user).toContain('wss://relay.e2e-test.example');
      expect(stored.removed).toContain('wss://nos.lol');

      // And the effective set the publisher resolves must reflect both edits.
      const effective = await sw.evaluate(async () => {
        const s = await chrome.storage.local.get(['relays', 'userRelays', 'removedRelays']);
        const DEFAULTS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.snort.social'];
        const mode = s.relays === 'local' || s.relays === 'production' ? s.relays : 'production';
        if (mode === 'local') return ['ws://localhost:7777'];
        const user = (s.userRelays as string[] | undefined) ?? [];
        const removed = new Set((s.removedRelays as string[] | undefined) ?? []);
        const merged = [...new Set([...DEFAULTS, ...user])].filter((u) => !removed.has(u));
        return merged.length > 0 ? merged : DEFAULTS;
      });

      expect(effective).toContain('wss://relay.e2e-test.example');
      expect(effective).not.toContain('wss://nos.lol');
      expect(effective).toContain('wss://relay.primal.net');
    } finally {
      await ctx.close();
    }
  });

  test('the overlay\'s "Manage relays" opens the web app with settings already showing', async () => {
    const { ctx } = await launchWithExtension();
    try {
      // Invoke the background's OPEN_HOME handler exactly as the overlay's
      // "Manage relays" button does. It runs inside an extension page (the
      // onboarding page the extension opens on install), because
      // runtime.sendMessage called from the service worker posts to the worker
      // itself, where nothing listens.
      const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');

      // resolveBaseUrl() targets production unless a localhost:3000 tab is
      // already open. Open one first or the deep-link lands on the LIVE site,
      // which of course lacks the local build.
      const localTab = await ctx.newPage();
      await localTab.goto(CLIPS_URL, { waitUntil: 'load' });

      const extPage = await ctx.newPage();
      const extUrl = await sw.evaluate(() =>
        chrome.runtime.getURL('src/onboarding/onboarding.html'));
      await extPage.goto(extUrl, { waitUntil: 'load' });
      await extPage.evaluate(async () => {
        await chrome.runtime.sendMessage({ type: 'OPEN_HOME', openSettings: true });
      });

      // The regression this guards: landing on the feed with the relay UI
      // hidden behind the settings gear. Find the discerns tab by URL rather
      // than taking the next 'page' event — the extension opens its own tabs.
      let opened: import('@playwright/test').Page | undefined;
      for (let i = 0; i < 30 && !opened; i++) {
        opened = ctx.pages().find((p) => p.url().includes('/discerns?settings=1'));
        if (!opened) await extPage.waitForTimeout(500);
      }
      if (!opened) throw new Error(`no /discerns tab; open: ${ctx.pages().map((p) => p.url()).join(', ')}`);
      // The tab is caught the moment its URL is set, which can be before the
      // document has even parsed — wait for the app itself, not just the URL.
      await opened.waitForLoadState('domcontentloaded');
      await opened.locator('.topbar').waitFor({ state: 'visible', timeout: 20_000 });

      expect(opened.url()).toContain('/discerns');
      await expect(opened.locator('.modal')).toBeVisible({ timeout: 15_000 });
      await expect(opened.locator('.relay-row').first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});
