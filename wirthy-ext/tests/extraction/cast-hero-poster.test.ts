// Guards castImageUrlFromBody — the CAST half of the "wrong image at the top"
// defect (user report 2026-09-11, snapchat.com/web).
//
// posterFromBody already stopped a feed's site-wide og:image from becoming the
// CLIP's preview. The cast still showed it: pickImageUrl (shared/nostr/events)
// ranks `thumbnailUrl` FIRST and skips data: URIs, and thumbnailUrl was left
// holding the raw og:image. On a feed every post shares one URL, so the
// staleness guard in headTagsDescribeCurrentPage legitimately passes, and every
// cast heroed the site's own branding instead of the post.
//
// Tested at the helper rather than through captureContext because the play card
// is built by a site tagger's postClone, which needs real layout — under jsdom
// no tagger runs, so the shape this helper exists to read never appears.

import { describe, it, expect } from 'vitest';
import { castImageUrlFromBody } from '@/content/capture';

const OG = 'https://cdn.example.com/site-branding-logo.png';
const FRAME = 'https://cdn.example.com/posts/post-42-frame.jpg';

// What the pipeline ships once a poster has been inlined: base64 in `src`, the
// real URL preserved in `data-dx-src` (see dxSrcAttr).
const inlinedCard = (real: string | null) =>
  `<div><a class="tweet-video" href="https://feed.example.com/@someone">` +
  `<img src="data:image/png;base64,AAAA" alt="Video thumbnail" class="tweet-video-poster"` +
  `${real ? ` data-dx-src="${real}"` : ''}></a><p>Post body.</p></div>`;

describe('castImageUrlFromBody', () => {
  it("casts the post's own frame instead of the site-wide og:image", () => {
    expect(castImageUrlFromBody(inlinedCard(FRAME), OG)).toBe(FRAME);
  });

  it('drops the og:image when the poster has no real URL (blob: canvas frame)', () => {
    // snapchat.com/web: the poster is a canvas grab off an MSE stream, so there
    // is no http(s) URL to publish. A cast with NO hero is correct here — the
    // alternative is heroing another post's branding.
    expect(castImageUrlFromBody(inlinedCard(null), OG)).toBeNull();
  });

  it('leaves the og:image alone when the body has no play card', () => {
    // The ordinary article path: withThumbnailFallback may legitimately promote
    // the og:image as the hero, and thumbnail-fallback.test.ts asserts it stays.
    const html = '<div><h1>An article</h1><p>Prose, no video.</p></div>';
    expect(castImageUrlFromBody(html, OG)).toBe(OG);
  });

  it('accepts a poster that was never inlined (real URL still in src)', () => {
    const html = `<div><a class="tweet-video" href="#">` +
      `<img src="${FRAME}" class="tweet-video-poster"></a></div>`;
    expect(castImageUrlFromBody(html, OG)).toBe(FRAME);
  });

  it('un-escapes an entity-encoded data-dx-src', () => {
    const raw = 'https://cdn.example.com/f.jpg?a=1&amp;b=2';
    const html = `<div><img class="tweet-video-poster" src="data:image/png;base64,AA" data-dx-src="${raw}"></div>`;
    expect(castImageUrlFromBody(html, OG)).toBe('https://cdn.example.com/f.jpg?a=1&b=2');
  });

  it('rejects an unsafe poster URL rather than casting it', () => {
    const html = `<div><img class="tweet-video-poster" src="javascript:alert(1)"></div>`;
    expect(castImageUrlFromBody(html, OG)).toBeNull();
  });
});
