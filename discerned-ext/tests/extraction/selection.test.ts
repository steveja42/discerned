import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

function selectElementById(id: string): void {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Fixture element #${id} not found`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  if (!sel) throw new Error('No selection API in jsdom');
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('selection extraction', () => {
  it('captures a selected element as a sanitized fragment', async () => {
    loadFixture('blog-post.html', 'http://127.0.0.1:4173/blog-post.html');
    selectElementById('lede');
    const cap = await captureContext('selection');
    expect(cap.format).toBe('selection');
    expect(cap.selectionText ?? '').toContain('measure my reading');
    // Sanitization invariants
    expect(cap.selectionText ?? '').not.toMatch(/<script[\s>]/i);
    expect(cap.selectionText ?? '').not.toMatch(/\son\w+\s*=/i);
  });

  it('falls back to bookmark when nothing is selected', async () => {
    loadFixture('blog-post.html', 'http://127.0.0.1:4173/blog-post.html');
    window.getSelection()?.removeAllRanges();
    const cap = await captureContext('selection');
    // Per extractSelection() at capture.ts:134, empty selection falls back to extractBookmark.
    expect(cap.format).toBe('bookmark');
  });

  it('produces a context string with the [...] separator', async () => {
    loadFixture('blog-post.html', 'http://127.0.0.1:4173/blog-post.html');
    selectElementById('title');
    const cap = await captureContext('selection');
    expect(typeof cap.selectionContext).toBe('string');
    expect(cap.selectionContext ?? '').toContain('[...]');
  });

  // A selection can span a nav/aside/role=complementary widget that only
  // renders visibly-broken content once its wrapping tag is unwrapped by
  // sanitisation (e.g. a recipe-card serving-size scaler's error fallback).
  // extractArticle/extractFullPage already drop these via stripPageChrome;
  // extractSelection must too, or the widget's text leaks into the clip.
  it('drops landmark chrome (nav/aside/role=complementary) from a selection', async () => {
    document.body.innerHTML = `
      <article id="post">
        <h1>Chicken Parmesan</h1>
        <div id="scope">
          <nav role="navigation" aria-label="Serving size">
            <button>1/2x</button><button>1x</button><button>2x</button>
            <p>Oops! Something went wrong. Our team is working on it.</p>
          </nav>
          <p>4 skinless, boneless chicken breast halves</p>
        </div>
      </article>
    `;
    selectElementById('scope');
    const cap = await captureContext('selection');
    expect(cap.format).toBe('selection');
    const html = cap.selectionText ?? '';
    expect(html).toContain('4 skinless, boneless chicken breast halves');
    expect(html).not.toContain('Oops! Something went wrong');
    expect(html).not.toContain('1/2x');
  });

  // extractArticle/extractFullPage both run tagSemanticStructure (dx-byline /
  // dx-stats / dx-quote generic detection) before sanitising; extractSelection
  // didn't, so a selection spanning a byline lost the CSS layout treatment
  // that keeps "Author Name" and its <time> from reading as run-together text.
  it('stamps dx-byline on an avatar-less byline inside a selection', async () => {
    document.body.innerHTML = `
      <article id="post">
        <h1>A post</h1>
        <div id="scope">
          <div class="meta"><a href="/author/jsmith">Jane Smith</a> <time datetime="2026-09-20">Sep 20</time></div>
          <p>Body text goes here.</p>
        </div>
      </article>
    `;
    selectElementById('scope');
    const cap = await captureContext('selection');
    expect(cap.selectionText ?? '').toMatch(/class="[^"]*dx-byline[^"]*"/);
  });
});
