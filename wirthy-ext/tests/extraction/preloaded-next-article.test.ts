// Guards the generic infinite-scroll PRELOADED-next-article exclusion
// (PRELOADED_NEXT_SELECTOR).
//
// Real-world defect (MSN, user report 2026-08-03 — "the wrong thing is
// clipped"): an MSN `/ss-<id>` slideshow page preloads the next feed stories
// into the SAME DOM inside `div.consumptionFeed_nextArticle` wrappers. The
// viewed story is a gallery whose text lives in per-slide fragments and which
// contains NO <article>, so the only <article> elements on the page belonged to
// the PRELOADED stories. findArticleElement's first selector (`article`)
// matched one of those, and the clip shipped an unrelated article under the
// slideshow's title.
//
// The fix skips preloaded-next wrappers in findArticleElement, scoreContentBlock
// (layout finder), AND markExcluded (so they drop from a whole-page capture).
// Like the comment-widget guard this must hold in BOTH detection modes: the
// corpus Vitest run uses smartArticleDetection=true, while the live capture
// bridge uses false — which is where the bug actually surfaced.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('preloaded next-article exclusion (msn-slideshow fixture)', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`captures the viewed slideshow, not the preloaded next story (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture(
        'msn-slideshow.html',
        'https://www.msn.com/en-us/entertainment/celebrities/paramount-s-star-trek-reboot-drops-kirk-for-new-era/ss-AA29f2aF',
      );
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });
      const text = cap.bodyText ?? '';

      // The story the user is viewing is present…
      expect(text, 'viewed slideshow body present').toContain('Kirk era ends');
      expect(text, 'viewed slideshow body present').toContain('Kelvin-timeline');

      // …and neither preloaded next article rides along.
      expect(text, 'preloaded story #1 excluded').not.toContain('Fetterman');
      expect(text, 'preloaded story #1 excluded').not.toContain('filibuster');
      expect(text, 'preloaded story #2 excluded').not.toContain('Mortgage rates');
    });
  }
});
