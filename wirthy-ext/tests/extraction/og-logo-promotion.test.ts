// Guards Guard 3 of withThumbnailFallback — the og:image PROMOTION POLICY.
//
// Promotion recovers a story's art when the capture root missed it (the MSN
// syndication case). But a site with no per-page art declares its BRAND MARK as
// og:image, and promoting that puts a large logo block above a page that has no
// hero at all. Reported on tildes, gitlab-repo, postgresql-docs, signalvnoise
// and mayoclinic; the CSS cap was already engaging, so the complaint is purely
// about whether such an image should be promoted (remediation plan, Phase 5c).
//
// Measured across the corpus (2026-09-16) the two kinds separate by ASPECT:
//   logos      144x144, 512x512, 300x300, 540x557  → 0.97-1.00
//   real cards 1200x630, 1200x675, 2400x1600, …    → 1.50-1.91
// A brand mark is square because that is what a logo is; an OG card is ~1.91:1
// by the spec sites follow. There is a wide margin between 0.97 and 1.50.
//
// The size comes from probeImageSize, which uses `new Image()` + naturalWidth —
// jsdom never loads images, so these tests stub it. That also means the guard is
// INERT in the rest of the suite (size unknown ⇒ previous behaviour), which is
// why the wide-card counter-test below stubs a size too: without it, it would
// pass whether or not the guard exists.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const FIXTURE = 'article-og-image-no-body-img.html';
const PAGE_URL = 'https://www.msn.com/en-us/money/general/astrazeneca-hit/ar-AA29gc1N';

/** Make probeImageSize see an image of exactly this intrinsic size. */
function stubImageSize(w: number, h: number): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = w;
    naturalHeight = h;
    set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
  }
  vi.stubGlobal('Image', FakeImage);
}

describe('og:image promotion policy (square site logos)', () => {
  beforeEach(() => { loadFixture(FIXTURE, PAGE_URL); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does NOT promote a square og:image (a site logo)', async () => {
    stubImageSize(144, 144); // tildes-logo-144x144.png
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const imgs = (cap.bodyHtml ?? '').match(/<img[^>]*>/gi) ?? [];
    expect(imgs.length, 'square logo is not promoted into the body').toBe(0);
    // The article itself is untouched — this drops one image, not content.
    expect(cap.bodyText ?? '').toContain('AstraZeneca shares have taken');
    // The two hero surfaces are BOTH refused: the clip's body (above) and the
    // CAST's hero, which reads thumbnailUrl and would otherwise still publish
    // the logo the clip just stopped showing.
    expect(cap.thumbnailUrl, 'cast hero refused too').toBeNull();
    // But the LIBRARY-ROW preview keeps it — a small logo is a fine visual key
    // for the site, and that is a different field.
    expect(cap.thumbnail, 'library-row preview still set').toBeTruthy();
    // …and it is FLAGGED, so the cast can skip it. Without the flag the cast
    // still heroed the logo: pickImageUrl falls through thumbnailUrl →
    // thumbnail, and an ungranted capture stores a plain http URL there (the
    // grant is what would have made it a data: URI, which pickImageUrl skips).
    expect(cap.thumbnailIsLogo, 'thumbnail flagged as a logo').toBe(true);
  });

  it('DOES still promote a wide og:card (1200x630)', async () => {
    stubImageSize(1200, 630); // the shape every real OG card uses
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const imgs = (cap.bodyHtml ?? '').match(/<img[^>]*>/gi) ?? [];
    expect(imgs.length, 'wide card is still promoted').toBe(1);
    expect(imgs[0]).toContain('data:image/');
  });

  it('leaves thumbnailIsLogo unset for a real card, so casts still hero it', async () => {
    // The counter-case for the flag: a wide card must NOT be flagged, or
    // pickImageUrl would skip a legitimate hero.
    stubImageSize(1200, 630);
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.thumbnailIsLogo, 'wide card is not flagged').toBeFalsy();
  });

  it('promotes a 4:3 photo — the band is tight around 1:1', async () => {
    // 1.33 is a normal photo aspect and must not be mistaken for a logo.
    stubImageSize(1200, 900);
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(((cap.bodyHtml ?? '').match(/<img[^>]*>/gi) ?? []).length).toBe(1);
  });
});
