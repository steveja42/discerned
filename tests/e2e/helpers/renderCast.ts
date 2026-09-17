// Renders a signed cast event through the REAL public feed (/discerns +
// DetailPanel) and screenshots the resulting .clip-body — the CAST render path
// (kind-30023 markdown → ReactMarkdown), as opposed to the private CLIP render
// (rich dx-* bodyHtml).
//
// The cast is PUBLISHED TO THE LOCAL RELAY (ws://localhost:7777) and the feed
// subscribes to it normally. It used to be served by a mocked WebSocket
// (page.routeWebSocket), which forced the render into a fresh, extension-free
// browser: the mock must own the socket, and the extension's web-bridge competes
// for it. That cold browser has no standing with bot-defended sites, so their
// CDNs 403 its image requests and the cast screenshot showed broken glyphs while
// the CLIP — rendered in the warm profile — showed the same images fine (measured
// on ndtv: hero naturalWidth 0 cold vs 1010 warm, same cast, same URL).
//
// With no mock there is nothing to isolate, so a caller that HAS a warm context
// passes it in and the cast renders there. It is also the more faithful test:
// the feed's real subscribe path runs instead of a fabricated conversation.
//
// Used by the live-visual specs to emit a third screenshot per site
// ({site}-cast.png) beside {site}-source.png (the website) and
// {site}-rendered.png (the clip), so casts are visually verified too.

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import type { NostrEvent } from 'nostr-tools/core';
import { screenshotClipBody } from './clipShot';
import { ensureLocalRelay, publishToLocalRelay } from './localRelay';

/**
 * Serve the event from a MOCKED socket: the page sees exactly this one cast.
 *
 * Kept for the FIXTURE baselines. They pin `capture.timestamp` to a fixed past
 * instant so the rendered date cannot rot, which means their cast sorts old —
 * and the shared local relay accumulates every cast previous runs published, so
 * a 50-event feed pushes the fixture's own row off the end and the row wait
 * times out. Fixtures also only ever touch localhost, so they gain nothing from
 * a warm browser. Isolation is the right trade for them; reputation is the right
 * trade for live captures.
 */
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

/**
 * Put the one event on the local relay and pin the page to `local` relay mode.
 *
 * The mode pin is what makes the feed look at ws://localhost:7777. It also keeps
 * a connected extension harmless: `applyRelayMode` early-returns when the mode
 * it is handed already matches, so the extension's DISCERNED_BRIDGE_RELAYS
 * message (which reports `local` for a dev/test build) is a no-op rather than a
 * re-subscribe to somewhere else.
 */
async function serveViaLocalRelay(page: Page, event: NostrEvent): Promise<void> {
  await ensureLocalRelay();
  await publishToLocalRelay(event);
  await page.addInitScript(() => {
    try { localStorage.setItem('discerned.relayMode', 'local'); } catch { /* ignore */ }
  });
}

export interface RenderCastOptions {
  /** Text expected in the feed row, to disambiguate + wait for it. Defaults to the event title tag. */
  rowText?: string;
  /** Where to write the cast screenshot. */
  screenshotPath: string;
  /** Cap for very tall cast bodies (forwarded to screenshotClipBody). */
  maxHeight?: number;
  /**
   * Render in THIS context instead of a throwaway browser. Pass the warm,
   * extension-loaded context whenever you have one: a cold automation browser
   * is refused by bot-defended CDNs, so its cast screenshot shows broken images
   * that a real reader would never see. Omitted, a plain browser is launched
   * (right for fixtures, which only touch localhost).
   */
  context?: BrowserContext;
}

/**
 * Run `fn` against a page in `context`, or in a throwaway browser when none is
 * given. Only a browser this opened is closed; a caller's context is left alone.
 */
async function withCastPage<T>(
  context: BrowserContext | undefined,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  if (context) {
    const page = await context.newPage();
    try { return await fn(page); } finally { await page.close().catch(() => undefined); }
  }
  const browser = await chromium.launch();
  const own = await browser.newContext();
  try { return await fn(await own.newPage()); } finally {
    await own.close();
    await browser.close();
  }
}

/**
 * Open a cast and hand the settled page + .clip-body locator to `fn`.
 *
 * renderCastAndScreenshot takes its own screenshot and returns a string, which
 * is right for the live specs (an artifact for a human to look at) but cannot
 * drive toHaveScreenshot — a pixel baseline needs the LOCATOR, inside the
 * running test. This is the same setup, with the screenshot step left to the
 * caller, so the cast fixture baselines and the live artifacts share one render
 * path and cannot drift.
 */
export async function withRenderedCast<T>(
  event: NostrEvent,
  opts: { rowText?: string; context?: BrowserContext },
  fn: (page: Page, clipBody: ReturnType<Page['locator']>) => Promise<T>,
): Promise<T> {
  return withCastPage(opts.context, async (page) => {
    const clipBody = await openCast(page, event, opts.rowText, !!opts.context);
    return fn(page, clipBody);
  });
}

/**
 * Shared readiness path: mock the relay with this one event, open /discerns,
 * select the row, and wait for the cast body + its images to settle.
 */
async function openCast(
  page: Page,
  event: NostrEvent,
  rowTextOpt?: string,
  viaRelay = false,
): Promise<ReturnType<Page['locator']>> {
  if (viaRelay) await serveViaLocalRelay(page, event);
  else await mockRelayWith(page, event);
  // NOT networkidle: the feed holds its relay socket open by design, so the
  // network never goes idle and this goto hangs forever. castShotSafe only
  // catches THROWS, so a hang here burned the whole 240s per-domain deadline
  // (github-pr, whose clip and web-app render had both already succeeded).
  // 'domcontentloaded' + the explicit row/clip-body waits below are the real
  // readiness signal.
  await page.goto('http://localhost:3000/discerns', {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  });

  // The relay is a PERSISTENT store, so on the relay path the feed carries every
  // cast earlier runs published — never `.first()` there, which is the trap the
  // CLIP render documents (8 domains once shared one stale image). Match the
  // title, which `ClipRow` renders as `.clip-title`. Every test cast shares one
  // author key, so the npub cannot disambiguate; the title is what differs.
  const rowText = rowTextOpt ?? titleOf(event);
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
  return clipBody;
}

function titleOf(event: NostrEvent): string {
  const t = event.tags.find((tag) => tag[0] === 'title');
  return t?.[1] ?? '';
}

/**
 * Render a cast through the real feed: publish the single event to the local
 * relay, select the row on /discerns, wait for images to decode, and screenshot
 * the cast body. Returns its innerText for optional assertions.
 *
 * Pass `context` to render in a warm, extension-loaded browser (see the module
 * header — a cold one gets its images 403'd by bot-defended CDNs). Without a
 * mocked socket the extension is no longer in the way: it delivers clips over
 * postMessage, a different path from the cast feed, and its relay-mode message
 * is a no-op because both sides are already `local`. Rows are matched by
 * `rowText`, so a feed carrying other clips still resolves to this cast.
 */
export async function renderCastAndScreenshot(
  event: NostrEvent,
  opts: RenderCastOptions,
): Promise<string> {
  return withCastPage(opts.context, async (page) => {
    const clipBody = await openCast(page, event, opts.rowText, !!opts.context);
    await screenshotClipBody(page, clipBody, opts.screenshotPath, opts.maxHeight ?? 8000);
    return (await clipBody.innerText().catch(() => '')) ?? '';
  });
}
