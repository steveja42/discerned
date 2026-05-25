// Verifies that captureContext('article') and captureContext('selection')
// descend into open shadow roots. Stansberry's Angular widgets ship content
// via <template shadowrootmode="open">; capture must reach inside.

import { describe, it, expect, beforeEach } from 'vitest';
import { captureContext, hasSelection } from '@/content/capture';

function resetDocument(url: string): void {
  document.open();
  document.write('<!doctype html><html><head><title>shadow-dom test</title></head><body></body></html>');
  document.close();
  const u = new URL(url);
  Object.defineProperty(window, 'location', {
    value: {
      href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
      hostname: u.hostname, port: u.port, pathname: u.pathname,
      search: u.search, hash: u.hash, toString() { return u.href; },
    },
    writable: true, configurable: true,
  });
}

/**
 * Build a page where the only article-grade prose lives inside an open
 * shadow root on a custom element — the same structural shape Stansberry
 * uses. Returns the shadow host so tests can construct ranges inside it.
 */
function buildShadowArticlePage(): { host: HTMLElement; shadowRoot: ShadowRoot } {
  // Light DOM: page chrome with low-quality text (page footer / nav) so the
  // layout finder would otherwise pick this and miss the article.
  document.body.innerHTML = `
    <header>
      <a href="/home">Home</a><a href="/about">About</a><a href="/contact">Contact</a>
    </header>
    <footer>
      <a href="/legal">Legal</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a>
      <a href="/cookies">Cookies</a><a href="/sitemap">Sitemap</a>
    </footer>
  `;

  // The widget host with open shadow root containing the actual article.
  const host = document.createElement('widget-media-content');
  document.body.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });
  shadowRoot.innerHTML = `
    <div id="articleSnippet">
      <h1>The Real Article Title</h1>
      <p>This is the first paragraph of substantive article content that the layout
      finder should select. It contains several sentences of plain prose with a
      reasonable text-to-link ratio so it scores well against the page chrome.</p>
      <p>The second paragraph adds more text density. Lorem ipsum dolor sit amet,
      consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et
      dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation.</p>
      <p>A third paragraph for good measure, ensuring we comfortably clear the
      LAYOUT_MIN_TEXT_CHARS threshold and the smartArticleDetection signals.</p>
    </div>
  `;

  return { host, shadowRoot };
}

describe('shadow-DOM-aware capture', () => {
  beforeEach(() => {
    resetDocument('http://127.0.0.1:4173/shadow-test.html');
  });

  it('captureContext("article") reaches into an open shadow root for the body', async () => {
    buildShadowArticlePage();
    const cap = await captureContext('article');
    expect(cap.format).toBe('article');
    // Body text should come from inside the shadow root, NOT from the footer's
    // link soup. Test the specific marker sentence we put in the shadow body.
    expect(cap.bodyText ?? '').toContain('substantive article content');
    expect(cap.bodyText ?? '').not.toContain('Legal');
    // And the rendered HTML should carry the <p> structure inlined from the
    // shadow root, not be empty.
    expect((cap.bodyHtml ?? '').toLowerCase()).toMatch(/<p[\s>]/);
  });

  it('captureContext("full-page") inlines open shadow content into the clone', async () => {
    buildShadowArticlePage();
    const cap = await captureContext('full-page');
    expect(cap.format).toBe('full-page');
    // Full-page goes through deepCloneWithShadow on document.body, so shadow
    // content must appear in the result.
    expect(cap.bodyText ?? '').toContain('substantive article content');
  });

  it('captureContext("article") on a page with NO shadow roots is unchanged', async () => {
    document.body.innerHTML = `
      <article>
        <h1>Plain Article</h1>
        <p>This article lives entirely in the light DOM and should be captured
        through the normal Tier 1 semantic-element path. The text here is long
        enough to clear ARTICLE_MIN_CHARS so findArticleElement returns it.</p>
        <p>More prose to be sure we have plenty of body. Lorem ipsum dolor sit
        amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.</p>
      </article>
    `;
    const cap = await captureContext('article');
    expect(cap.format).toBe('article');
    expect(cap.bodyText ?? '').toContain('entirely in the light DOM');
  });

  it('hasSelection returns false when nothing is selected anywhere', () => {
    buildShadowArticlePage();
    // No selection made — should be false in both light DOM and shadow.
    expect(hasSelection()).toBe(false);
  });

  it('collapseEmpty removes empty <i>/<div>/<span> wrappers from sanitised output', async () => {
    document.body.innerHTML = `
      <article>
        <h1>Real Title</h1>
        <p>Substantive paragraph text long enough to clear the minimum-chars
        threshold so this article path is taken and the body is captured for
        sanitisation. The collapse pass should run on the cloned subtree.</p>
        <div><i></i></div>
        <span>   </span>
        <div><div><span></span></div></div>
        <div><i class="fa-solid fa-play"></i></div>
      </article>
    `;
    const cap = await captureContext('article');
    expect(cap.format).toBe('article');
    const html = cap.bodyHtml ?? '';
    expect(html).toContain('Real Title');
    expect(html).toContain('Substantive paragraph');
    // Empty wrappers must be gone. <i></i> after class strip is empty; nested
    // empty <div><span></span></div> chains are empty; whitespace-only <span>
    // is empty. None should survive in the output.
    expect(html).not.toMatch(/<i\s*>\s*<\/i>/i);
    expect(html).not.toMatch(/<div\s*>\s*<\/div>/i);
    expect(html).not.toMatch(/<span\s*>\s*<\/span>/i);
  });

  it('header detector stamps dx-header on wrappers with larger author headshots', async () => {
    // Author-block pattern: <div><span><img 100x100><a>Name</a></span></div>.
    // Stansberry's headshot renders ~100 px, which was rejected by the old
    // HEADER_AVATAR_MAX_PX=72. Raising it to 128 should let this wrapper qualify.
    document.body.innerHTML = `
      <article>
        <div class="author-block">
          <span class="author-wrap">
            <img src="https://example.com/headshot.png" width="100" height="100" alt="Author">
            <a href="/team/author">Eric Wade</a>
          </span>
        </div>
        <p>Body paragraph with enough text to comfortably push this article over
        ARTICLE_MIN_CHARS so findArticleElement returns the <article> root and
        sanitisation runs the generic semantic-structure tagger over the clone.</p>
        <p>Second paragraph for additional text density and to ensure we're well
        above the minimum thresholds for both the semantic and the layout finders.</p>
      </article>
    `;
    const cap = await captureContext('article');
    expect(cap.format).toBe('article');
    const html = cap.bodyHtml ?? '';
    // The wrapper span should now carry dx-header (the only class token that
    // survives sanitisation besides tweet-*).
    expect(html).toMatch(/class="[^"]*\bdx-header\b/);
  });
});
