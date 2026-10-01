import { describe, it, expect, afterEach, vi } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('full-page extraction', () => {
  it('captures the body of a content-bearing page', async () => {
    loadFixture('blog-post.html', 'http://127.0.0.1:4173/blog-post.html');
    const cap = await captureContext('full-page');
    expect(cap.format).toBe('full-page');
    expect(cap.url).toBe('http://127.0.0.1:4173/blog-post.html');
    expect(cap.bodyText ?? '').toContain('slow');
    expect((cap.bodyText ?? '').length).toBeGreaterThan(300);
    expect(cap.bodyHtml).toBeTruthy();
  });

  it('strips scripts, iframes, and inline event handlers', async () => {
    loadFixture('xss-injected.html', 'http://127.0.0.1:4173/xss-injected.html');
    const cap = await captureContext('full-page');
    const html = cap.bodyHtml ?? '';
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/<iframe[\s>]/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/=\s*["']?\s*javascript\s*:/i);
  });

  it('survives a near-empty document', async () => {
    loadFixture('malformed.html', 'http://127.0.0.1:4173/malformed.html');
    const cap = await captureContext('full-page');
    expect(cap.format).toBe('full-page');
    expect(typeof cap.bodyText).toBe('string');
  });

  // Same square-logo guard extractArticle applies (og-logo-promotion.test.ts):
  // a site with no per-page art declares its brand mark as og:image, and
  // full-page previously had no logo check at all, so its cast would hero
  // with the site's logo instead of nothing.
  describe('square-logo cast-hero guard', () => {
    const FIXTURE = 'article-og-image-no-body-img.html';
    const PAGE_URL = 'https://www.msn.com/en-us/money/general/astrazeneca-hit/ar-AA29gc1N';

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

    afterEach(() => { vi.unstubAllGlobals(); });

    it('flags a square og:image and refuses it as the cast hero', async () => {
      stubImageSize(144, 144);
      loadFixture(FIXTURE, PAGE_URL);
      const cap = await captureContext('full-page');
      expect(cap.thumbnailIsLogo).toBe(true);
      expect(cap.thumbnailUrl).toBeNull();
      // Library-row preview keeps the logo — a fine visual key for the site.
      expect(cap.thumbnail).toBeTruthy();
    });

    it('leaves a wide og:card unflagged so the cast still heroes it', async () => {
      stubImageSize(1200, 630);
      loadFixture(FIXTURE, PAGE_URL);
      const cap = await captureContext('full-page');
      expect(cap.thumbnailIsLogo).toBeFalsy();
      expect(cap.thumbnailUrl).toBe('https://cdn.example.com/hero-astrazeneca.jpg');
    });
  });
});
