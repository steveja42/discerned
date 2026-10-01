import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const FIXTURES: Array<{ name: string; url: string; expectedTitleContains: string }> = [
  { name: 'news-article.html',   url: 'http://127.0.0.1:4173/news-article.html',   expectedTitleContains: 'Breaking' },
  { name: 'blog-post.html',      url: 'http://127.0.0.1:4173/blog-post.html',      expectedTitleContains: 'Slow Reading' },
  { name: 'wikipedia.html',      url: 'http://127.0.0.1:4173/wikipedia.html',      expectedTitleContains: 'Tantalum' },
  { name: 'github-readme.html',  url: 'http://127.0.0.1:4173/github-readme.html',  expectedTitleContains: 'tiny-yaml' },
  { name: 'substack-essay.html', url: 'http://127.0.0.1:4173/substack-essay.html', expectedTitleContains: 'Cost of Coordination' },
  { name: 'plain-text.html',     url: 'http://127.0.0.1:4173/plain-text.html',     expectedTitleContains: 'Plain Text' },
  { name: 'malformed.html',      url: 'http://127.0.0.1:4173/malformed.html',      expectedTitleContains: 'Nothing Here' },
];

describe('bookmark extraction', () => {
  it.each(FIXTURES)('captures $name as a bookmark', async ({ name, url, expectedTitleContains }) => {
    loadFixture(name, url);
    const cap = await captureContext('bookmark');
    expect(cap.format).toBe('bookmark');
    expect(cap.url).toBe(url);
    expect(cap.title).toContain(expectedTitleContains);
    expect(typeof cap.id).toBe('string');
    expect(cap.id.length).toBeGreaterThan(0);
    expect(cap.timestamp).toBeGreaterThan(0);
    // bookmark must not carry article/selection bodies
    expect(cap.bodyHtml).toBeUndefined();
    expect(cap.bodyText).toBeUndefined();
    expect(cap.selectionText).toBeUndefined();
  });

  it('returns null thumbnail when neither og:image nor an <img> exists', async () => {
    loadFixture('malformed.html', 'http://127.0.0.1:4173/malformed.html');
    const cap = await captureContext('bookmark');
    expect(cap.thumbnail).toBeNull();
  });

  it('returns the og:image when present', async () => {
    loadFixture('news-article.html', 'http://127.0.0.1:4173/news-article.html');
    const cap = await captureContext('bookmark');
    expect(cap.thumbnail).toBe('https://example.com/og/news-hero.jpg');
  });
});
