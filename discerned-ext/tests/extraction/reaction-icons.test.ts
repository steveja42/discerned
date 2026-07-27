// Guards dedupRepeatedIcons — drops repeated small ICON images (reaction glyphs,
// subscribe badges, the author avatar) a page renders across its engagement
// chrome (dev.to shows the reaction bar at top / sticky / foot; the author
// avatar in the nav / byline / author card). Distance-independent, keyed on an
// exact URL stem among icon-sized images, scoped OUT of thread structure so
// per-comment avatars survive.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

// Count the <img> TAGS whose src/data-dx-src contains `stem` (one count per
// image, even though an inlined tag carries the URL in BOTH src and data-dx-src).
const countSrc = (html: string, stem: string): number =>
  (html.match(/<img\b[^>]*>/gi) ?? []).filter(tag => tag.includes(stem)).length;

describe('dedupRepeatedIcons (reaction-icons fixture)', () => {
  it('collapses repeated engagement icons but keeps thread avatars + content photos', async () => {
    loadFixture('reaction-icons.html', 'https://dev.to/francistrdev/choose-your-burden');
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const html = cap.bodyHtml ?? '';

    // Repeated engagement icons: rendered 2-3× on the page → exactly ONE survives.
    expect(countSrc(html, 'sparkle-heart-5f9bee3767e18deb'), 'sparkle-heart deduped to 1').toBe(1);
    expect(countSrc(html, 'multi-unicorn-b44d6f8c23cdd0'), 'multi-unicorn deduped to 1').toBe(1);
    expect(countSrc(html, 'subscription-icon-805dfa7ac7dd66'), 'subscribe icon deduped to 1').toBe(1);

    // The author avatar appears 2× (byline + foot) → collapses to 1.
    expect(countSrc(html, '12345/avatar.png'), 'author avatar deduped to 1').toBe(1);

    // Per-comment avatars inside dx-post/dx-reply are DIFFERENT people — both survive.
    expect(countSrc(html, '999/alice.png'), 'alice avatar kept').toBe(1);
    expect(countSrc(html, '888/bob.png'), 'bob avatar kept').toBe(1);

    // The real content photo is large (not icon-sized) → never touched.
    expect(countSrc(html, 'yoda-focus'), 'content photo kept').toBe(1);
  });
});
