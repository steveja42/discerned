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
});
