// Guards the generic e-commerce / entity-page chrome passes at the bodyHtml
// level: removeCrossSellRails (product carousels), removeReviewsSection (the
// customer-reviews scroll + its dangling ratings-summary), and the commerce-
// chrome pass (author "Follow" cards). These fire on product/entity pages that
// are NOT prose articles (no <article>, no page <h1>) — the shape that made
// amazon.com/dp capture the whole page (reviews + cross-sell) and bury the
// product. See tests/fixtures/sites/entity-product.html.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('entity/product page chrome removal (bodyHtml level)', () => {
  it('drops cross-sell rails, the customer-reviews scroll, and author follow cards; keeps product info', async () => {
    loadFixture('entity-product.html', 'https://www.amazon.com/dp/0345339681');
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const html = cap.bodyHtml ?? '';

    // ── Product content SURVIVES ──────────────────────────────────────────
    expect(html).toContain('The Hobbit');
    expect(html).toContain('the greatest'); // description prose
    expect(html).toContain('320 pages');    // product details
    expect(html).toContain('Editorial Reviews');
    expect(html).toContain('From the Inside Flap');

    // ── Cross-sell rails REMOVED (both the storefront + "also bought" shapes) ──
    expect(html).not.toContain('Explore more across the store');
    expect(html).not.toContain('Customers who bought this item also bought');
    expect(html).not.toContain('Anne of Green Gables');
    expect(html).not.toContain('Treasure Island');
    expect(html).not.toContain('The Children of Hurin');

    // ── Customer-reviews scroll REMOVED (heading, summary, and every review) ──
    expect(html).not.toContain('Customer reviews');
    expect(html).not.toContain('Reviews with images');
    expect(html).not.toContain('Top reviews from the United States');
    expect(html).not.toContain('Verified Purchase');
    expect(html).not.toContain('found this helpful');
    expect(html).not.toContain('An absolute classic');

    // ── Author "Follow" card REMOVED ─────────────────────────────────────
    expect(html).not.toContain('Follow the authors');

    // ── Buy box REMOVED (leads the DOM above the cover) ──────────────────
    expect(html).not.toContain('Add to cart');
    expect(html).not.toContain('Buy Now');
    expect(html).not.toContain('In Stock');
    expect(html).not.toContain('Other sellers on Amazon');
    expect(html).not.toContain('47 percent savings');
    expect(html).not.toContain('Shipper / Seller');
  });

  // The orphan-ratings cleanup in removeReviewsSection used to delete ANY
  // prose-free block under a REVIEWS_SECTION_RE heading. On a REVIEW site the
  // aggregate block is the primary content, so that silently dropped
  // StoryGraph's whole "Community Reviews" section — the 4.29 score, the review
  // count, the mood percentages and the pace/plot distribution bars.
  // hasAggregateRatingData() now keeps a block carrying real aggregate data.
  // Note the Amazon case above still works because that reviews medley is
  // removed by the MAIN pass (≥3 per-review signals), never reaching this
  // cleanup — the two are guarded independently and both are asserted here.
  it('keeps an aggregate ratings summary that has no individual reviews (review-site shape)', async () => {
    loadFixture('review-aggregate.html', 'https://app.thestorygraph.com/books/x');
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const html = cap.bodyHtml ?? '';

    // The book's own info survives.
    expect(html).toContain('Fruit Fly');

    // The aggregate review data survives — this is what regressed.
    expect(html).toContain('Community Reviews');
    expect(html).toContain('4.29');
    expect(html).toContain('1,292 reviews');
    expect(html).toContain('dark: 92%');
    expect(html).toContain('Pace');

    // The counterpart still holds: a prose-free block under a reviews heading
    // that carries NO aggregate data is still dropped by the orphan cleanup.
    // ("Review this book" is a REVIEWS_SECTION_RE heading; "Rate this book" is
    // deliberately not one, so it is out of this pass's scope either way.)
    expect(html).not.toContain('Be the first to review');
  });
});
