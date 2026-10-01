// Guards stripZeroWidthChars — removal of invisible scraping-defence characters.
//
// Facebook interleaves U+034F (COMBINING GRAPHEME JOINER) between every visible
// character of a post's text. It renders identically on the page, but the
// captured text comes out as "s͏n͏t͏r͏p͏o͏e͏S͏d͏o͏g͏9͏" — unreadable in the
// clip, unsearchable in the library, and garbage in a published cast.
//
// Generic on purpose: zero-width space / non-joiner / joiner / word-joiner and
// the BOM are all used the same way by other sites, so the pass covers them too
// rather than special-casing Facebook.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';

/** Interleave a character between every letter, the way Facebook does. */
function poison(text: string, ch: string): string {
  return text.split('').join(ch) + ch;
}

describe('zero-width scraping-defence characters', () => {
  it('strips U+034F interleaved through post text (real Facebook shape)', async () => {
    const clean = 'Grandson and Great Grandson are here from Nebraska and we are having such a fun time together today.';
    document.body.innerHTML =
      `<main><article><p>${poison(clean, '͏')}</p>` +
      `<p>${poison('A second paragraph of the very same post body text here.', '͏')}</p></article></main>`;

    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const text = cap.bodyText ?? '';
    expect(text, 'the joiner must be gone').not.toContain('͏');
    expect(text, 'readable text is recovered').toContain('Grandson and Great Grandson');
  });

  it('strips zero-width space / non-joiner / joiner / BOM', async () => {
    const clean = 'This paragraph is long enough to survive the capture pipeline intact.';
    document.body.innerHTML = '<main><article>' +
      `<p>${poison(clean, '​')}</p>` +
      `<p>${poison('Another sentence that is also comfortably long enough here.', '‍')}</p>` +
      `<p>${poison('And a third one so the block clears the prose threshold.', '﻿')}</p>` +
      '</article></main>';

    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const text = cap.bodyText ?? '';
    for (const ch of ['​', '‌', '‍', '⁠', '﻿']) {
      expect(text, `${ch.codePointAt(0)!.toString(16)} must be gone`).not.toContain(ch);
    }
    expect(text).toContain('This paragraph is long enough');
  });

  it('leaves ordinary text (and real emoji) untouched', async () => {
    // The stripper must not eat legitimate characters — emoji are multi-codepoint
    // and some use U+200D as a real joiner INSIDE a single glyph, so a plain
    // global strip would break them. Family emoji is the classic case.
    const body = 'A normal paragraph with an emoji 😀 and a family 👨‍👩‍👧 in it, long enough to keep.';
    document.body.innerHTML = `<main><article><p>${body}</p>` +
      '<p>Second paragraph so the article block has enough prose to be chosen.</p></article></main>';

    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const text = cap.bodyText ?? '';
    expect(text).toContain('A normal paragraph with an emoji 😀');
    expect(text).toContain('family');
  });
});
