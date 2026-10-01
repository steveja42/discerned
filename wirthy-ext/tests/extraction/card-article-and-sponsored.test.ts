// Guards two generic corpus-sweep (Phase 4.3) fixes:
//
// (1) findArticleElement CARD-<article> skip. Business Insider renders related-
//     story "tout" cards as the FIRST <article> on the page, and Letterboxd
//     renders each user review as <article class="production-viewing …">. With
//     smartArticleDetection=false (the sweep bridge default) findArticleElement's
//     first `article` match grabbed the CARD → shipped a ~200-char teaser and
//     dropped the story (bodyText 171/71 chars in the live sweep). The fix skips
//     an <article> that is one of ≥2 sibling article cards (a feed) OR carries a
//     card-ish class + is dwarfed by a bigger block, so <main> wins.
//
// (2) SPONSORED_WIDGET_SELECTOR strip. A Taboola/Outbrain/… native-ad recirculation
//     grid rides at the article tail; markExcluded drops it so its paid teaser
//     text ("Sponsored …", "Learn More") never ships in the clip.
//
// Both must hold in BOTH detection modes — the corpus Vitest run uses
// smartArticleDetection=true, but the live sweep bridge uses false, which is where
// the bugs surfaced.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('card-<article> skip + sponsored-widget strip (Phase 4.3 fixes)', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`captures the story, skips tout/review cards + Taboola (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture('card-article-and-sponsored.html', 'https://example.com/great-coding-reset');
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });
      const text = cap.bodyText ?? '';

      // (1) The real story (in <main>) is captured, not a tout card.
      expect(text, 'story headline present').toContain('The Great Coding Reset');
      expect(text, 'story body present').toContain('field guide to the new normal');
      // The recommendation "tout" CARD teasers must NOT be the capture.
      expect(text, 'tout card excluded').not.toContain('totally different teaser headline');
      expect(text, 'tout card excluded').not.toContain('third promoted teaser card');

      // (2) The Taboola sponsored recirculation grid is stripped.
      expect(text, 'sponsored teaser excluded').not.toContain('Just Beyond Devastating');
      expect(text, 'sponsored teaser excluded').not.toContain('Melts Belly Fat');
      expect(text, 'sponsored label excluded').not.toMatch(/Sponsored/);

      // (3) The "Latest Mobiles" shopping-sister-site rail (cards link to
      // gadgetsnow) is stripped by removeSisterSiteRail.
      expect(text, 'Latest Mobiles heading excluded').not.toContain('Latest Mobiles');
      expect(text, 'Latest Mobiles grid excluded').not.toContain('OPPO Reno');
      expect(text, 'Latest Mobiles grid excluded').not.toContain('Nokia G42');

      // (4) First-party recirculation tails (Photostories / Hot Picks / Top
      // Trending) stripped by RECIRC_WIDGET_SELECTOR (photosslider / articletrendinglist).
      expect(text, 'Photostories excluded').not.toContain('Photostories');
      expect(text, 'Photostories grid excluded').not.toContain('photo-gallery teaser');
      expect(text, 'Hot Picks excluded').not.toContain('Hot Picks');
      expect(text, 'Top Trending excluded').not.toContain('Top Trending');
      expect(text, 'trending link list excluded').not.toContain('trending story link');

      // Article body still intact after all the tail-stripping.
      expect(text, 'story survived').toContain('field guide to the new normal');
    });
  }
});
