// Regression: How-to Geek style image carousel (Splide) — the main track's
// slides each carry an expand <button> in the rendered DOM. That must NOT make
// the slide track look like a dx-stats icon row: html-to-markdown drops
// dx-stats subtrees wholesale, which silently removed every gallery photo from
// the published kind-30023 cast while the private clip (bodyHtml) and the
// imeta tags still had them. The fixture bakes the per-slide buttons in.
import { describe, expect, it } from 'vitest';
import { captureContext } from '@/content/capture';
import { htmlToMarkdown } from '@/content/html-to-markdown';
import { sourceHtmlForLongForm, createLongFormEvent } from '@/shared/nostr/events';
import type { Evaluation } from '@/shared/types';
import { loadFixture } from '../helpers/loadFixture';

const GALLERY_STEMS = [
  '2025-05-16_13-06-20_921', // OBD-II P0302
  '2020-09-23_14-04-01_243', // OBD-II P0303
  '2025-05-16_13-06-33_772', // OBD-II U0155
  '2026-07-10_16-24-00_196', // OBD-II Menu
  '2026-07-10_16-24-15_412', // OBD-II no codes
];

const EVALUATION: Evaluation = {
  signal: undefined,
  qualifiers: [],
  category: 'General',
} as unknown as Evaluation;

describe('htg gallery long-form cast', () => {
  it('keeps all 5 gallery photos, once each, in markdown + imageUrls + published content', async () => {
    loadFixture('htg-gallery.html', 'http://127.0.0.1:4173/htg-gallery.html');
    const cap = await captureContext('article', { smartArticleDetection: true, stripInlineStyles: false });

    // Deduped to one copy per photo (main res), thumbnails dropped.
    const urls = cap.imageUrls ?? [];
    expect(urls).toHaveLength(GALLERY_STEMS.length);
    for (const stem of GALLERY_STEMS) {
      expect(urls.filter((u) => u.includes(stem))).toHaveLength(1);
    }
    expect(urls.every((u) => u.includes('w=750'))).toBe(true);

    // The carousel track must not be swallowed as a dx-stats icon row: every
    // photo survives into the cast markdown as ![alt](main-res-url).
    const md = htmlToMarkdown(sourceHtmlForLongForm(cap)!);
    for (const stem of GALLERY_STEMS) {
      const lines = md.split('\n').filter((l) => l.includes('![') && l.includes(stem));
      expect(lines, `gallery photo ${stem} missing from markdown`).toHaveLength(1);
      expect(lines[0]).toContain('w=750');
    }

    // Aspect-ratio sizer paddings (padding-bottom: 56.25% lazy-load wrappers)
    // are zeroed at capture time — left alive they reserve inches of blank
    // space above each photo in the rendered clip.
    expect(cap.bodyHtml).not.toMatch(/padding-(top|bottom)\s*:\s*\d+(?:\.\d+)?%/i);

    // And through to the published kind-30023 content (stripLeadingArticleChrome
    // must not eat non-hero gallery images).
    const evt = createLongFormEvent(cap, EVALUATION, md);
    for (const stem of GALLERY_STEMS) {
      expect(evt.content).toContain(stem);
    }
    expect(evt.tags.filter((t) => t[0] === 'imeta')).toHaveLength(GALLERY_STEMS.length);
  });
});
