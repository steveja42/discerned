// Guards the generic third-party comment-widget exclusion (COMMENT_WIDGET_SELECTOR).
//
// Real-world defect (AP News): the page has no real <article> — only
// <main class="Page-main"> — and embeds a Viafoura reader-comments thread whose
// comments are <article class="vf3-comment">. With smartArticleDetection=false
// (the capture default), findArticleElement's first selector `article` matched
// the FIRST comment, so the clip shipped the comments and dropped the story.
//
// The fix skips comment-widget elements in findArticleElement, scoreContentBlock
// (layout finder), AND markExcluded (so they drop from a whole-<main> capture).
// This must hold in BOTH detection modes — the corpus Vitest run uses
// smartArticleDetection=true, but the live sweep bridge uses false, which is
// where the bug actually surfaced.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('third-party comment-widget exclusion (apnews-article fixture)', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`captures the story not the Viafoura comments (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture('apnews-article.html', 'https://apnews.com/article/russia-ukraine');
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });
      const text = cap.bodyText ?? '';
      // Story markers present…
      expect(text, 'story body present').toContain('Zaporizhzhia');
      expect(text, 'story body present').toContain('Rocheleau');
      // …and the comment thread is NOT the capture.
      expect(text, 'comment author excluded').not.toContain('wintersoldier');
      expect(text, 'comment text excluded').not.toContain('war crime, plain and simple');
      expect(text.length, 'substantial story body').toBeGreaterThan(1000);
    });
  }
});
