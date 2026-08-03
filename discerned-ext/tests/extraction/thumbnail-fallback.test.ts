// Guards withThumbnailFallback — the og:image hero recovery shared by every
// article tier (Tier 1 / layout finder / Readability).
//
// Real-world defect (MSN /ar- articles, user report 2026-08-03: "this site has
// an image which shows up in the cast, but not in the clip"): MSN renders the
// hero in a sibling web component the capture root doesn't cover, so the clip
// body came out with zero <img> while the CAST still showed the picture. They
// read different fields — the cast renders `thumbnailUrl`, the clip renders
// `bodyHtml`. An og:image fallback already existed but ONLY in Tier 2
// (Readability), and MSN wins via a different tier, so the clip stayed
// image-less. The fix hoists that logic into a shared helper used by all tiers.
//
// BOTH directions matter, and the negative one is not hypothetical: the first
// version of this fix injected the og:image whenever the body had no <img>,
// without checking the image could actually load. On the offline fixture corpus
// (whose og:image URLs don't resolve) that put a permanently-broken image —
// alt text + a broken-image glyph — at the top of four previously-clean pixel
// baselines. The fallback is therefore gated on the thumbnail having been
// SUCCESSFULLY INLINED (a data: URI), so it can only ever add an image that is
// known to display.
//
// The suite's chrome.runtime stub answers INLINE_IMAGE with a real 1x1 data:
// PNG (tests/setup.ts), which is what lets the positive case run offline.

import { describe, it, expect, vi } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const FIXTURE = 'article-og-image-no-body-img.html';
const PAGE_URL = 'https://www.msn.com/en-us/money/general/astrazeneca-hit/ar-AA29gc1N';

describe('og:image hero fallback (withThumbnailFallback)', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`recovers the hero into the clip body when the article has none (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture(FIXTURE, PAGE_URL);
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });

      // The body genuinely had no image of its own — otherwise this test would
      // pass without the fallback ever running.
      expect(cap.thumbnailUrl, 'og:image picked up as the thumbnail')
        .toBe('https://cdn.example.com/hero-astrazeneca.jpg');

      // …and the CLIP body now carries an image, inlined like any in-body one.
      const imgs = (cap.bodyHtml ?? '').match(/<img[^>]*>/gi) ?? [];
      expect(imgs.length, 'clip body has the recovered hero').toBe(1);
      expect(imgs[0], 'hero is inlined, not a bare remote URL').toContain('data:image/');

      // The cast's image set must agree with the clip — that the two disagreed
      // is the entire bug.
      expect(cap.imageUrls ?? [], 'cast image set includes the hero')
        .toContain('https://cdn.example.com/hero-astrazeneca.jpg');

      // Article prose is still intact (the <figure> is prepended, not replacing).
      expect(cap.bodyText ?? '').toContain('AstraZeneca shares have taken');
    });
  }

  it('does NOT inject a first-<img> GUESS when the page declares no og:image', async () => {
    // getPageThumbnail falls back to the first <img> on the page when there is
    // no og:image. That guess is fine for a library-row thumbnail but is NOT a
    // hero — on Hacker News it's `y18.gif`, a 1x1 transparent spacer. Promoting
    // it into the clip body added an invisible figure that pushed the whole
    // thread down 32px and broke the HN pixel baseline. It inlines perfectly
    // well, so the data:-URI guard can't catch it; provenance is the signal.
    loadFixture('hackernews-thread.html', 'https://news.ycombinator.com/item?id=38710079');
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });

    // The thumbnail is still captured (the library row wants one)…
    expect(cap.thumbnailUrl, 'first-img guess still becomes the row thumbnail').toBeTruthy();
    // …but it must NOT be promoted into the clip body.
    expect((cap.bodyHtml ?? '').match(/<img[^>]*>/gi) ?? [], 'no guessed image in the body')
      .toHaveLength(0);
    // The thread itself is intact.
    expect(cap.bodyText ?? '').toContain('247 points');
  });

  it('does NOT inject the hero when the image cannot be fetched', async () => {
    // Make INLINE_IMAGE fail the way it does for an unreachable og:image:
    // inlineImage falls through and hands back the ORIGINAL URL, so there are
    // no inlined bytes and the fallback must decline. Without this gate the
    // clip gets a permanently-broken <img> (the 4-baseline regression above).
    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const original = sendMessage.getMockImplementation();
    sendMessage.mockImplementation(async (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'INLINE_IMAGE') return { success: false };
      return { success: true };
    });

    try {
      loadFixture(FIXTURE, PAGE_URL);
      const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });

      expect((cap.bodyHtml ?? '').match(/<img[^>]*>/gi) ?? [], 'no broken image injected').toHaveLength(0);
      // The prose is still captured — declining the hero must not cost content.
      expect(cap.bodyText ?? '').toContain('AstraZeneca shares have taken');
    } finally {
      if (original) sendMessage.mockImplementation(original);
    }
  });
});
