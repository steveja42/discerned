import { test } from '@playwright/test';

test('shot signal exact select', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('discerned.relayMode', 'production'); } catch {}
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('http://localhost:3000/discerns', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // Click the middle Signal pip (Passable = index 2, "P").
  const pips = page.locator('.axis-range .pip');
  await pips.nth(2).click();
  await page.waitForTimeout(500);
  await page.locator('.sidebar').screenshot({ path: 'C:/Users/steve/AppData/Local/Temp/claude/c--dev-discerned-discerned-ext/67101d68-8a5d-4e13-888d-b440dce8e87b/scratchpad/sidebar.png' });
});
