import { describe, it, expect } from 'vitest';
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
});
