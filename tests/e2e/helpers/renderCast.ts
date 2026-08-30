// Renders a signed cast event through the REAL public feed (/discerns +
// DetailPanel) and screenshots the resulting .clip-body — the CAST render path
// (kind-30023 markdown → ReactMarkdown), as opposed to the private CLIP render
// (rich dx-* bodyHtml). Mocks the Nostr relay the same way web-cast-render and
// web-feed specs do (page.routeWebSocket returning the one event for any REQ).
//
// Used by the live-visual specs to emit a third screenshot per site
// ({site}-cast.png) beside {site}-source.png (the website) and
// {site}-rendered.png (the clip), so casts are visually verified too.

import { chromium, type Page } from '@playwright/test';
import type { NostrEvent } from 'nostr-tools/core';
import { screenshotClipBody } from './clipShot';

async function mockRelayWith(page: Page, event: NostrEvent): Promise<void> {
  // Force production relay mode so the feed subscribes over wss:// (which we
  // intercept) rather than the local dev relay.
  await page.addInitScript(() => {
    try { localStorage.setItem('discerned.relayMode', 'production'); } catch { /* ignore */ }
  });
  await page.routeWebSocket(/^wss:\/\//, (ws) => {
    ws.onMessage((message: string | Buffer) => {
      const msg = typeof message === 'string' ? message : message.toString();
      try {
        const parsed = JSON.parse(msg);
        if (Array.isArray(parsed) && parsed[0] === 'REQ') {
          const subId = parsed[1];
          ws.send(JSON.stringify(['EVENT', subId, event]));
          ws.send(JSON.stringify(['EOSE', subId]));
        }
      } catch { /* ignore non-JSON frames */ }
    });
  });
}

export interface RenderCastOptions {
  /** Text expected in the feed row, to disambiguate + wait for it. Defaults to the event title tag. */
  rowText?: string;
  /** Where to write the cast screenshot. */
  screenshotPath: string;
  /** Cap for very tall cast bodies (forwarded to screenshotClipBody). */
  maxHeight?: number;
}

function titleOf(event: NostrEvent): string {
  const t = event.tags.find((tag) => tag[0] === 'title');
  return t?.[1] ?? '';
}

/**
 * Render a cast in a FRESH, extension-free Chromium browser: feed it the single
 * cast event through a mocked relay, select the row on /discerns, wait for
 * images to decode, and screenshot the rendered cast body. Returns the innerText
 * of the cast body for optional assertions.
 *
 * Deliberately NOT the extension's persistent context — on localhost:3000 the
 * extension's web-bridge injects the user's real clips + forces a first-run
 * onboarding redirect, and its content scripts fight the mocked relay. A plain
 * browser lets page.routeWebSocket own the feed's data, exactly like the
 * web-cast-render + tweet-cast-photos specs (default `web` project browser).
 */
export async function renderCastAndScreenshot(
  event: NostrEvent,
  opts: RenderCastOptions,
): Promise<string> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await mockRelayWith(page, event);
    // NOT networkidle: the feed is served by a MOCKED relay socket
    // (page.routeWebSocket) that stays open by design, so the network never goes
    // idle and this goto hangs forever. castShotSafe only catches THROWS, so a
    // hang here burned the whole 240s per-domain deadline (github-pr, whose clip
    // and web-app render had both already succeeded). 'domcontentloaded' + the
    // explicit row/clip-body waits below are the real readiness signal.
    await page.goto('http://localhost:3000/discerns', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });

    const rowText = opts.rowText ?? titleOf(event);
    const row = rowText
      ? page.locator('article.clip', { hasText: rowText }).first()
      : page.locator('article.clip').first();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.click();

    const clipBody = page.locator('.clip-body');
    await clipBody.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait for every rendered image to finish decoding so the screenshot is not
    // taken mid-reflow (same guard the fixture-visual driver uses).
    await clipBody.evaluate(async (root) => {
      const imgs = Array.from(root.querySelectorAll('img'));
      await Promise.all(imgs.map((img) =>
        (img.complete && img.naturalWidth > 0)
          ? Promise.resolve()
          : img.decode().catch(() => undefined),
      ));
    });
    await page.waitForTimeout(500);

    await screenshotClipBody(page, clipBody, opts.screenshotPath, opts.maxHeight ?? 8000);

    return (await clipBody.innerText().catch(() => '')) ?? '';
  } finally {
    await context.close();
    await browser.close();
  }
}
