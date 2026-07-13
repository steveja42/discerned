// Verifies that a TWEET CAST (kind:1 published from an x.com capture) renders
// in the public feed's DetailPanel with its full photo gallery + enriched body
// text (author, tweet text, engagement counts, date). Also covers a QUOTE-tweet
// cast: the embedded older post's author, text, and photos must appear too.
// Mocks the Nostr relay (like web-feed.spec.ts) and drives the feed → detail
// selection, then screenshots the rendered .clip-body.
//
// Run with: TWEET_CAST=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=tweet-cast-photos-visual

import { test, expect, type Page } from '@playwright/test';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const PHOTOS = [
  'https://pbs.twimg.com/media/HIUNHegXwAAVKkB?format=webp&name=medium',
  'https://pbs.twimg.com/media/HIUNHfhWEAAYw_t?format=webp&name=medium',
  'https://pbs.twimg.com/media/HIUNHefWAAAQpb9?format=webp&name=medium',
];

// A quote-tweet cast: 2 outer photos + 2 quoted photos, and a "> …" blockquote
// carrying the embedded post's author + text.
const OUTER_PHOTOS = [
  'https://pbs.twimg.com/media/HMuQCFLbgAASdG7?format=webp&name=medium',
  'https://pbs.twimg.com/media/HMuQDJcaMAA6qtr?format=webp&name=medium',
];
const QUOTE_PHOTOS = [
  'https://pbs.twimg.com/media/HMtS-m5bcAAVy4Q?format=webp&name=small',
  'https://pbs.twimg.com/media/HMtTAaAasAAjZMg?format=webp&name=small',
];

function signCast(tags: string[][], content: string): NostrEvent {
  const sk = generateSecretKey();
  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
  return finalizeEvent(template, sk);
}

// Mirrors what createResourceNoteEvent produces for a plain tweet cast.
function buildTweetCast(): NostrEvent {
  const body = 'CIA @CIA\nHavana, Cuba\n\n💬 1330  ·  🔁 7058  ·  ❤️ 43386  ·  🔖 3363  ·  11:57 PM · May 14, 2026';
  return signCast(
    [
      ['r', 'https://x.com/CIA/status/2055074954375254084'],
      ['L', 'online.discerned.category'],
      ['l', 'General', 'online.discerned.category'],
      ['t', 'discerned'],
      ['format', 'full-page'],
      ['client', 'discerned'],
      ['title', 'CIA on X: "Havana, Cuba'],
      ['image', PHOTOS[0]],
      ['body', body],
      ...PHOTOS.map((u): string[] => ['imeta', `url ${u}`]),
    ],
    `Discerned: General\n\nCIA on X: "Havana, Cuba\nhttps://x.com/CIA/status/2055074954375254084\n\n--- body ---\n${body}\n\n${PHOTOS.join('\n')}`,
  );
}

// Mirrors createResourceNoteEvent for a quote-tweet cast (outer + embedded).
function buildQuoteTweetCast(): NostrEvent {
  const allPhotos = [...OUTER_PHOTOS, ...QUOTE_PHOTOS];
  const body = [
    'Coin Bureau @coinbureau',
    'META WANTS AI GLASSES THAT REMEMBER YOUR DAY',
    '',
    '> Coin Bureau @coinbureau',
    "> META'S MUSE AI FACES BACKLASH OVER PROFILE PHOTO USE",
    '',
    '💬 66  ·  🔁 16  ·  ❤️ 109  ·  🔖 20  ·  5:49 PM · Jul 8, 2026',
  ].join('\n');
  return signCast(
    [
      ['r', 'https://x.com/coinbureau/status/2074913657469984786'],
      ['L', 'online.discerned.category'],
      ['l', 'General', 'online.discerned.category'],
      ['t', 'discerned'],
      ['format', 'full-page'],
      ['client', 'discerned'],
      ['title', 'Coin Bureau on X'],
      ['image', OUTER_PHOTOS[0]],
      ['body', body],
      ...allPhotos.map((u): string[] => ['imeta', `url ${u}`]),
    ],
    `Discerned: General\n\nCoin Bureau on X\nhttps://x.com/coinbureau/status/2074913657469984786\n\n--- body ---\n${body}\n\n${allPhotos.join('\n')}`,
  );
}

// Mirrors createResourceNoteEvent for an ARTICLE cast whose body interleaves
// the image URLs at their in-article positions (the proseText behavior). The
// web app must render those images inline where their URL lines sit — and
// show NO top gallery, since every imeta URL is present in the body.
function buildArticleCast(): NostrEvent {
  const body = [
    'Your home server deserves better than hand-me-down hardware.',
    '',
    PHOTOS[0],
    '',
    'Treating it like a spare PC means spare-PC reliability: no ECC, no redundancy, no plan for the day the disk dies.',
    '',
    PHOTOS[1],
    '',
    'A modest, purpose-built box beats a retired gaming rig for anything that has to stay up.',
  ].join('\n');
  return signCast(
    [
      ['r', 'https://example.com/home-server-article'],
      ['L', 'online.discerned.category'],
      ['l', 'General', 'online.discerned.category'],
      ['t', 'discerned'],
      ['format', 'article'],
      ['client', 'discerned'],
      ['title', 'Your Home Server Deserves Better'],
      ['image', PHOTOS[0]],
      ['body', body],
      ['imeta', `url ${PHOTOS[0]}`],
      ['imeta', `url ${PHOTOS[1]}`],
    ],
    `Discerned: General\n\nYour Home Server Deserves Better\nhttps://example.com/home-server-article\n\n--- body ---\n${body}`,
  );
}

async function mockRelayWith(page: Page, event: NostrEvent): Promise<void> {
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

async function openDetailAndDecode(page: Page, rowText: string) {
  await page.goto('/discerns');
  const row = page.locator('article.clip', { hasText: rowText }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
  const clipBody = page.locator('.clip-body');
  await clipBody.waitFor({ state: 'visible', timeout: 10_000 });
  await clipBody.evaluate(async (root) => {
    const imgs = Array.from(root.querySelectorAll('img'));
    await Promise.all(imgs.map((img) =>
      (img.complete && img.naturalWidth > 0) ? Promise.resolve() : img.decode().catch(() => undefined),
    ));
  });
  await page.waitForTimeout(500);
  return clipBody;
}

test('tweet-cast-photos-visual', async ({ page }) => {
  test.skip(!process.env.TWEET_CAST, 'set TWEET_CAST=1 to run this');
  test.setTimeout(60_000);
  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

  await mockRelayWith(page, buildTweetCast());
  const clipBody = await openDetailAndDecode(page, 'Havana');

  await expect(clipBody.locator('.cast-photos img')).toHaveCount(3);
  await expect(clipBody).toContainText('💬 1330');
  await expect(clipBody).toContainText('11:57 PM · May 14, 2026');
  await expect(clipBody).toContainText('@CIA');

  await clipBody.screenshot({ path: resolve(outDir, 'tweet-cast-photos-rendered.png') });
});

test('article-cast-inline-images-visual', async ({ page }) => {
  test.skip(!process.env.TWEET_CAST, 'set TWEET_CAST=1 to run this');
  test.setTimeout(60_000);
  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

  await mockRelayWith(page, buildArticleCast());
  const clipBody = await openDetailAndDecode(page, 'Home Server');

  // Both images render inline (at their URL lines), NOT as a top gallery.
  await expect(clipBody.locator('img.cast-inline-img')).toHaveCount(2);
  await expect(clipBody.locator('.cast-photos')).toHaveCount(0);
  // The bare URL text must not remain visible.
  await expect(clipBody).not.toContainText('pbs.twimg.com');
  // Position: the first inline image sits between paragraph 1 and paragraph 2.
  const order = await clipBody.evaluate((root) => {
    const kids = Array.from(root.children).map((el) =>
      el.tagName === 'IMG' ? 'img' : (el.textContent ?? '').slice(0, 20));
    return kids;
  });
  const firstImg = order.indexOf('img');
  const paraAfter = order.findIndex((t) => t.startsWith('Treating it like'));
  expect(firstImg).toBeGreaterThan(0);
  expect(paraAfter).toBeGreaterThan(firstImg);

  await clipBody.screenshot({ path: resolve(outDir, 'article-cast-inline-rendered.png') });
});

test('tweet-cast-quote-visual', async ({ page }) => {
  test.skip(!process.env.TWEET_CAST, 'set TWEET_CAST=1 to run this');
  test.setTimeout(60_000);
  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

  await mockRelayWith(page, buildQuoteTweetCast());
  const clipBody = await openDetailAndDecode(page, 'AI GLASSES');

  // All four photos (2 outer + 2 quoted) render in the gallery.
  await expect(clipBody.locator('.cast-photos img')).toHaveCount(4);
  // Outer tweet text.
  await expect(clipBody).toContainText('AI GLASSES THAT REMEMBER YOUR DAY');
  // Embedded (quoted) tweet author + text carried through.
  await expect(clipBody).toContainText('MUSE AI FACES BACKLASH');
  await expect(clipBody).toContainText('@coinbureau');

  await clipBody.screenshot({ path: resolve(outDir, 'tweet-cast-quote-rendered.png') });
});
