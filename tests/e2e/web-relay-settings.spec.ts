// Drives the Settings → Relays UI the way a user does: open the modal, read the
// rendered rows, add a relay, remove one. Also verifies that a relay list pushed
// over the bridge (which is how NIP-65 relays discovered at sign-in arrive)
// shows up live, badged as coming from the user's Nostr profile.
//
// Screenshots land in test-output/ for human review of the layout.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'test-output');
mkdirSync(OUT, { recursive: true });

// The dev server sets NEXT_PUBLIC_LOCAL_RELAY, so the web app boots in LOCAL
// relay mode — where the list is deliberately fixed and editing is disabled.
// Persist production mode before load so these specs exercise the editable path
// a real user sees. (The local-mode guard has its own test below.)
async function openSettings(page: import('@playwright/test').Page, mode: 'production' | 'local' = 'production') {
  await page.addInitScript((m) => {
    try { localStorage.setItem('discerned.relayMode', m); } catch { /* blocked storage */ }
    try { localStorage.removeItem('discerned.relayList'); } catch { /* blocked storage */ }
  }, mode);
  await page.goto('/clips');
  await page.waitForLoadState('networkidle');
  await page.locator('button[title="Settings"]').click();
  await expect(page.locator('.modal')).toBeVisible();
}

test.describe('web settings — relay management', () => {
  test('renders the default relays, each with a source badge', async ({ page }) => {
    await openSettings(page);

    const rows = page.locator('.relay-row');
    await expect(rows).toHaveCount(3); // the three built-in DEFAULT_RELAYS
    await expect(page.locator('.relay-url', { hasText: 'wss://relay.primal.net' })).toBeVisible();
    await expect(rows.first().locator('.relay-badge')).toHaveText('Default');

    await page.locator('.modal').screenshot({ path: join(OUT, 'relay-settings-default.png') });
  });

  test('adds a relay typed by the user', async ({ page }) => {
    await openSettings(page);

    await page.locator('.relay-add input').fill('wss://relay.example.com');
    await page.locator('.relay-add button').click();

    await expect(page.locator('.relay-row')).toHaveCount(4);
    const added = page.locator('.relay-row', { hasText: 'wss://relay.example.com' });
    await expect(added).toBeVisible();
    await expect(added.locator('.relay-badge')).toHaveText('Added by you');
    // Input clears so the next add doesn't append to the previous value.
    await expect(page.locator('.relay-add input')).toHaveValue('');

    await page.locator('.modal').screenshot({ path: join(OUT, 'relay-settings-added.png') });
  });

  test('normalises a bare host and rejects a non-websocket URL', async ({ page }) => {
    await openSettings(page);

    await page.locator('.relay-add input').fill('relay.bare-host.example');
    await page.locator('.relay-add button').click();
    await expect(
      page.locator('.relay-url', { hasText: 'wss://relay.bare-host.example' }),
    ).toBeVisible();

    await page.locator('.relay-add input').fill('https://not-a-relay.example.com');
    await page.locator('.relay-add button').click();
    await expect(page.locator('.relay-error')).toBeVisible();
    // The bad value was not added.
    await expect(page.locator('.relay-row', { hasText: 'not-a-relay' })).toHaveCount(0);

    await page.locator('.modal').screenshot({ path: join(OUT, 'relay-settings-error.png') });
  });

  test('refuses to add the same relay twice', async ({ page }) => {
    await openSettings(page);
    await page.locator('.relay-add input').fill('wss://relay.primal.net');
    await page.locator('.relay-add button').click();
    await expect(page.locator('.relay-error')).toContainText('already');
    await expect(page.locator('.relay-row')).toHaveCount(3);
  });

  test('removes a built-in default relay', async ({ page }) => {
    await openSettings(page);

    const target = page.locator('.relay-row', { hasText: 'wss://nos.lol' });
    await target.locator('.relay-remove').click();

    await expect(page.locator('.relay-row')).toHaveCount(2);
    await expect(page.locator('.relay-row', { hasText: 'wss://nos.lol' })).toHaveCount(0);
  });

  test('will not let the user remove their last relay', async ({ page }) => {
    await openSettings(page);

    // Remove down to one.
    await page.locator('.relay-row', { hasText: 'wss://nos.lol' }).locator('.relay-remove').click();
    await page.locator('.relay-row', { hasText: 'wss://relay.snort.social' })
      .locator('.relay-remove').click();

    await expect(page.locator('.relay-row')).toHaveCount(1);
    // The last row's remove button is disabled — a user must always have
    // somewhere to publish.
    await expect(page.locator('.relay-row .relay-remove')).toBeDisabled();

    await page.locator('.modal').screenshot({ path: join(OUT, 'relay-settings-last-relay.png') });
  });

  test('?settings=1 opens the settings panel directly (extension deep-link)', async ({ page }) => {
    // What the extension overlay's "Manage relays" button navigates to. Landing
    // on the feed and making the user find the gear is the bug this prevents.
    await page.goto('/discerns?settings=1');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.relay-row').first()).toBeVisible();

    // The param is stripped so a reload doesn't reopen the modal.
    expect(new URL(page.url()).searchParams.get('settings')).toBeNull();
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('the close button stays reachable when the modal scrolls', async ({ page }) => {
    // The relay list made this modal tall enough to overflow a short viewport.
    await page.setViewportSize({ width: 1280, height: 600 });
    await openSettings(page);

    const close = page.locator('.modal-close');
    await expect(close).toBeInViewport();
    await page.locator('.modal').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(close).toBeInViewport();
    await close.click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('disables editing in local relay mode, where the list is fixed', async ({ page }) => {
    await openSettings(page);

    // Flip the dev local-relay toggle. In local mode the effective set is
    // exactly [LOCAL_RELAY] — editing must be inert, or the UI would record
    // every production default as "removed".
    await page.locator('.settings-action', { hasText: 'Use local relay' }).click();

    await expect(page.locator('.relay-add input')).toBeDisabled();
    await expect(page.locator('.relay-add button')).toBeDisabled();
    await expect(page.locator('.relay-row .relay-remove').first()).toBeDisabled();

    await page.locator('.modal').screenshot({ path: join(OUT, 'relay-settings-local-mode.png') });
  });

  test('shows relays discovered from the user\'s Nostr profile when pushed over the bridge', async ({ page }) => {
    await openSettings(page);

    // This is exactly the message the extension posts after NIP-65 discovery.
    await page.evaluate(() => {
      window.postMessage({
        type: 'DISCERNED_BRIDGE_RELAY_LIST',
        rows: [
          { url: 'wss://relay.primal.net', source: 'default' },
          { url: 'wss://relay.from-my-profile.example', source: 'discovered' },
        ],
      }, window.location.origin);
    });

    const discovered = page.locator('.relay-row', { hasText: 'relay.from-my-profile.example' });
    await expect(discovered).toBeVisible();
    await expect(discovered.locator('.relay-badge')).toHaveText('From your Nostr profile');
    await expect(page.locator('.relay-row')).toHaveCount(2);

    await page.locator('.modal').screenshot({ path: join(OUT, 'relay-settings-discovered.png') });
  });
});
