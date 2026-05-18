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
});
