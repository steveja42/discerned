// Drive the extension's REAL activation gesture from a spec.
//
// Production ships no broad host permission: content.ts / nip07-bridge.ts are
// injected per tab under `activeTab`, which only a trusted user gesture on
// browser chrome confers. Playwright cannot click the toolbar icon — it is not
// in any page's DOM.
//
// A keyboard COMMAND is the way in. Chrome treats an extension command as a
// trusted gesture and grants activeTab exactly as a toolbar click does, and
// CDP's Input.dispatchKeyEvent does reach the command router. So specs press the
// extension's own shortcut and the REAL chrome.commands.onCommand handler in
// background.ts runs — no test-only injection hook, and the manifest under test
// is the one that ships.
//
// Two things are load-bearing and cost a while to find:
//   - Use a CUSTOM command, not `_execute_action`. The latter is handled
//     internally by Chrome and never reaches chrome.commands.onCommand.
//   - Chrome routes the command to the tab IT considers focused. page.
//     bringToFront() alone is not enough — the browser-level window focus must
//     be set too, or the command lands on whatever tab was focused before
//     (typically the install-time onboarding tab) and injection fails against
//     a chrome-extension:// URL.

import type { BrowserContext, Worker } from '@playwright/test';

/** Must match the `commands` key in manifest.json. */
const ACTIVATE_COMMAND_KEY = { key: 'Y', code: 'KeyY', vk: 89, modifiers: 9 }; // Alt+Shift+Y

async function getServiceWorker(ctx: BrowserContext): Promise<Worker> {
  const [existing] = ctx.serviceWorkers();
  if (existing) return existing;
  return ctx.waitForEvent('serviceworker', { timeout: 15_000 });
}

/**
 * Focus the tab serving `url` at the BROWSER level, then press the extension's
 * activation shortcut. Resolves once the keystroke has been dispatched; callers
 * wait on whatever the activation should produce.
 */
async function pressActivationShortcut(ctx: BrowserContext, url: string): Promise<void> {
  const sw = await getServiceWorker(ctx);
  const focused = await sw.evaluate(async (target: string) => {
    const [tab] = await chrome.tabs.query({ url: `${target}*` });
    if (tab?.id === undefined) return false;
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  }, url);
  if (!focused) throw new Error(`pressActivationShortcut: no tab matching ${url}`);

  const page = ctx.pages().find(p => p.url().startsWith(url));
  if (!page) throw new Error(`pressActivationShortcut: no page object for ${url}`);

  const cdp = await ctx.newCDPSession(page);
  const { key, code, vk, modifiers } = ACTIVATE_COMMAND_KEY;
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, modifiers, key, code,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
}

/**
 * Inject the content scripts into the tab serving `url` via the real gesture,
 * and wait until the content script is listening. Use before driving capture
 * through the __DISCERNED_TEST_* bridge.
 */
export async function activateExtensionOnTab(ctx: BrowserContext, url: string): Promise<void> {
  const page = ctx.pages().find(p => p.url().startsWith(url));
  if (!page) throw new Error(`activateExtensionOnTab: no page for ${url}`);

  // Cheap probe: is a content script already listening on this document? The
  // bridge answers __DISCERNED_TEST_PING synchronously once bound.
  const isReady = async (): Promise<boolean> => {
    try {
      return await page.evaluate(() => new Promise<boolean>((res) => {
        const t = setTimeout(() => { window.removeEventListener('message', on); res(false); }, 300);
        const on = (e: MessageEvent) => {
          if ((e.data as { type?: string })?.type !== '__DISCERNED_TEST_PING_RESULT') return;
          clearTimeout(t); window.removeEventListener('message', on); res(true);
        };
        window.addEventListener('message', on);
        window.postMessage({ type: '__DISCERNED_TEST_PING' }, window.location.origin);
      }));
    } catch {
      return false; // page navigated/closed mid-probe
    }
  };

  if (await isReady()) return;

  // Press the shortcut, then poll for the listener. Polling (rather than waiting
  // on the overlay) keeps this safe when a spec drives one page through many
  // fixtures back-to-back: a navigation mid-wait just fails the next probe
  // instead of throwing.
  await pressActivationShortcut(ctx, url);

  for (let i = 0; i < 40; i++) {
    if (await isReady()) {
      // Activation opens the overlay. Capture specs drive the test bridge
      // directly, so drop it — a mounted panel would sit in their screenshots.
      await page.evaluate(() => document.getElementById('discerned-overlay')?.remove()).catch(() => {});
      return;
    }
    await page.waitForTimeout(100).catch(() => { /* navigated away */ });
  }
  // Diagnostic: did the command even reach the browser?
  if (process.env.DEBUG_ACTIVATE) {
    try {
      const sw2 = await getServiceWorker(ctx);
      const info = await sw2.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const [act] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { count: tabs.length, active: act?.url ?? 'none' };
      });
      // eslint-disable-next-line no-console
      console.log('[activate-diag]', JSON.stringify(info));
    } catch { /* ignore */ }
  }
  throw new Error(`activateExtensionOnTab: content script never bound on ${url}`);
}

/**
 * Inject the content scripts AND leave the overlay open — the full toolbar-click
 * behaviour. Use for overlay specs; capture specs want activateExtensionOnTab.
 */
export async function openOverlayOnTab(ctx: BrowserContext, url: string): Promise<void> {
  const page = ctx.pages().find(p => p.url().startsWith(url));
  if (!page) throw new Error(`openOverlayOnTab: no page for ${url}`);
  await pressActivationShortcut(ctx, url);
  await page.waitForSelector('#discerned-overlay', { state: 'attached', timeout: 15_000 });
}
