import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('HTML sanitization', () => {
  it('strips every common XSS vector from article body', async () => {
    loadFixture('xss-injected.html', 'http://127.0.0.1:4173/xss-injected.html');
    const cap = await captureContext('article', {
      smartArticleDetection: true,
      stripInlineStyles: false,
    });
    const html = cap.bodyHtml ?? '';

    // No script execution surface
    expect(html, 'no <script>').not.toMatch(/<script[\s>]/i);
    expect(html, 'no <iframe>').not.toMatch(/<iframe[\s>]/i);
    expect(html, 'no <form>').not.toMatch(/<form[\s>]/i);
    expect(html, 'no inline event handlers').not.toMatch(/\son\w+\s*=/i);
    expect(html, 'no javascript: URLs').not.toMatch(/=\s*["']?\s*javascript\s*:/i);

    // The legitimate text must survive sanitization
    expect(html).toContain('benign content');
    expect(cap.bodyText ?? '').toContain('Lorem ipsum');
  });

  it('strips alert() payloads regardless of attribute case', async () => {
    loadFixture('xss-injected.html', 'http://127.0.0.1:4173/xss-injected.html');
    const cap = await captureContext('article', {
      smartArticleDetection: true,
      stripInlineStyles: true,
    });
    expect(cap.bodyHtml ?? '').not.toMatch(/alert\(/i);
  });
});
