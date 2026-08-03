// Guards the decorative-image exclusion (img[aria-hidden="true"] in markExcluded).
//
// Real-world defect (postguam.com, user report 2026-08-03: "shows each of the
// first two images twice on clips and cast"). TownNews/BLOX renders a blur-up
// lazy-load PAIR per photo: the real <img> (still lazy, so its src is a 4x3
// base64 spacer, real URL only in srcset) plus an `aria-hidden="true"` low-res
// placeholder holding the http URL. On the live page CSS layers one over the
// other; once sanitisation strips that CSS both render and every photo appears
// TWICE — in the clip AND the cast, since both derive from the same capture.
//
// Neither existing dedup pass can catch this pair, which is why a new signal was
// needed rather than a threshold tweak:
//   • dedupAdjacentImages keys on a shared URL stem OR a shared >10-char alt.
//     The lazy real <img> has a data: spacer src (no stem) and the placeholder
//     has alt="" — the pair shares NEITHER key.
//   • dedupGalleryThumbnails requires a real alt on BOTH copies.
// `aria-hidden` is the page's own declaration that the element is decorative.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const FIXTURE = 'blurup-lazy-images.html';
const PAGE_URL = 'https://www.postguam.com/news/national/ancient-dna-mammoths/article_926a34f9.html';

describe('blur-up lazy-load duplicate images (blurup-lazy-images fixture)', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`keeps one <img> per photo, not the aria-hidden twin (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture(FIXTURE, PAGE_URL);
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });
      const html = cap.bodyHtml ?? '';
      const imgs = html.match(/<img[^>]*>/gi) ?? [];

      // Two photos in the fixture, each present as a real+placeholder PAIR.
      // Without the fix this is 4.
      expect(imgs.length, 'one <img> per photo, placeholders dropped').toBe(2);

      // The surviving copies must be the REAL ones — they carry the descriptive
      // alt; the placeholders are alt="".
      expect(imgs[0], 'kept the real photo, not the placeholder')
        .toContain('Cavemen targeted female mammoths');
      expect(imgs[1], 'kept the real photo, not the placeholder')
        .toContain('pexels-theshuttervision');

      // The cast's image set must agree — the duplication showed in BOTH
      // surfaces, so deduping only the clip would be a half fix.
      const urls = cap.imageUrls ?? [];
      const bases = urls.map(u => u.split('?')[0]);
      expect(new Set(bases).size, 'no duplicate image URLs in the cast').toBe(bases.length);

      // Article prose is untouched.
      expect(cap.bodyText ?? '').toContain('Ancient DNA recovered from mammoth remains');
    });
  }
});
