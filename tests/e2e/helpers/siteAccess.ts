// The optional all-sites grant, toggled the way a USER does: the extension's own
// permissions page buttons. Chrome prompts only for the FIRST grant in a
// profile; after that a revoke + re-request is granted silently, so a profile a
// person has granted once can be toggled freely. No OS keystrokes: a stray Space
// once landed on the page's own revoke button and undid the grant.
import type { BrowserContext, Page, Worker } from '@playwright/test';

const ORIGINS = ['<all_urls>'];
// manifest.json pins the store key, so every build runs under the store ID.
const EXT_ID = 'gpfeknmodijdlehpnkfannklhplmfoma';

async function serviceWorker(ctx: BrowserContext): Promise<Worker> {
  const ours = (w: Worker) => new URL(w.url()).host === EXT_ID;
  return ctx.serviceWorkers().find(ours) ?? ctx.waitForEvent('serviceworker', { predicate: ours, timeout: 30_000 });
}

export async function hasAllSites(ctx: BrowserContext): Promise<boolean> {
  const sw = await serviceWorker(ctx);
  return sw.evaluate((o) => chrome.permissions.contains({ origins: o }), ORIGINS);
}

async function openPermissionsPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/src/permissions/permissions.html`);
  await page.bringToFront();
  return page;
}

async function waitFor(ctx: BrowserContext, page: Page, want: boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await hasAllSites(ctx) === want) return true;
    await page.waitForTimeout(250);
  }
  return await hasAllSites(ctx) === want;
}

export async function revokeAllSites(ctx: BrowserContext): Promise<boolean> {
  if (!(await hasAllSites(ctx))) return true;
  const page = await openPermissionsPage(ctx);
  try {
    await page.click('#btn-revoke');
    return await waitFor(ctx, page, false, 5000);
  } finally {
    await page.close();
  }
}

/** Click the grant button; if Chrome shows its prompt (first grant), wait up to `waitMs` for a person. */
export async function grantAllSites(ctx: BrowserContext, waitMs = 120_000): Promise<{ granted: boolean; how: string }> {
  if (await hasAllSites(ctx)) return { granted: true, how: 'already' };
  const page = await openPermissionsPage(ctx);
  try {
    await page.click('#btn-perm');
    if (await waitFor(ctx, page, true, 3000)) return { granted: true, how: 'silent re-grant' };
    // eslint-disable-next-line no-console
    console.log('>>> Chrome is prompting: click "Allow" in the test window.');
    return { granted: await waitFor(ctx, page, true, waitMs), how: 'person' };
  } finally {
    await page.close();
  }
}
