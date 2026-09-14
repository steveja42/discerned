// IDENTICAL to the control that got 200/200, except the extension is loaded.
// If this returns 403, the extension is the trigger.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const userDataDir = resolve('.vscode/browser-test-profiles/chrome');
const EXT = resolve('discerned-ext/dist-test');
const URLS = [
  'https://www.discogs.com/release/249504-Rick-Astley-Never-Gonna-Give-You-Up',
  'https://www.producthunt.com/products/chatgpt',
];
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: [
    '--profile-directory=Profile 3',
    '--disable-infobars',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});
for (const url of URLS) {
  const page = await ctx.newPage();
  const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => ({ err: String(e.message).slice(0,60) }));
  const status = r?.status?.() ?? r?.err ?? '?';
  const title = await page.title().catch(() => '');
  console.log(`${url.slice(0,52).padEnd(52)} status=${status} title="${title.slice(0,42)}"`);
  await page.close();
}
await ctx.close();
