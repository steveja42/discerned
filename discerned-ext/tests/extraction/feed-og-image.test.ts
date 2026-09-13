// Guards feedSafeThumbnail — "the cast shows the wrong image at the top" on a
// FEED (user reports 2026-09-11: snapchat.com/web, then instagram.com/?hl=en).
//
// A feed serves many posts under ONE url, so headTagsDescribeCurrentPage
// legitimately passes and the page's og:image becomes `thumbnailUrl`. But that
// image describes the SITE (Instagram serves a generic branding card on the
// logged-out feed), not the post that was captured — and pickImageUrl
// (shared/nostr/events.ts) ranks thumbnailUrl AHEAD of the post's own
// imageUrls, so the cast heroed Instagram's logo.
//
// The Snapchat fix (castImageUrlFromBody) only covered posts with a VIDEO play
// card. Instagram's feed is mostly photos and has no play card at all, so the
// og:image has to be rejected at the source instead.

import { describe, it, expect, afterEach } from 'vitest';
import { captureContext, __setTestHostOverride } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const OG = 'https://www.instagram.com/static/images/ico/favicon-192.png';
const PHOTO = 'https://scontent.cdninstagram.com/post-alice-photo.jpg';

describe('feed capture does not inherit the site-wide og:image', () => {
  afterEach(() => __setTestHostOverride(null));

  for (const smartArticleDetection of [false, true]) {
    it(`drops Instagram's branding card as the cast hero (smart=${smartArticleDetection})`, async () => {
      __setTestHostOverride('www.instagram.com');
      loadFixture('instagram-feed.html', 'https://www.instagram.com/?hl=en');
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });

      // The whole bug in one assertion: this is what the cast heroes.
      expect(cap.thumbnailUrl, 'cast must not hero the site branding').not.toBe(OG);
      // It heroes the POST's photo — not the 32px byline avatar, which is the
      // first <img> in document order and so the naive pick.
      expect(cap.thumbnailUrl, "cast heroes the post's own photo").toBe(PHOTO);

      // …and the clip keeps a preview rather than losing it to the fix.
      expect(cap.thumbnail, 'clip still has a preview').toBeTruthy();
    });
  }
});
