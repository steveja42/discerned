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

// Second AP News defect (corpus sweep, 2026-09-11 — "regressed" on apnews and
// apnews-tech): the story was captured intact but sat below ~4700px of chrome,
// because BOTH of these rode into the clip above the headline:
//
//   1. A leading <video> player plus a "More Videos" playlist rail of UNRELATED
//      videos (penguins, school kids, AP Newsminute).
//   2. A 6-slide photo carousel EXPANDED to all six slides. The page shows one
//      slide; the other five are position:absolute at left:100%..500%, i.e.
//      entirely outside the track, and only CSS the sanitiser strips hides them.
describe('AP News leading video rail + expanded carousel', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`drops the video rail and collapses the carousel (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture('apnews-article.html', 'https://apnews.com/article/russia-ukraine');
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });
      const text = cap.bodyText ?? '';
      const html = cap.bodyHtml ?? '';

      // The story still leads.
      expect(text, 'story body present').toContain('Zaporizhzhia');

      // 1. The "More Videos" rail and its unrelated thumbnails are gone.
      expect(text, 'playlist heading dropped').not.toMatch(/more videos/i);
      expect(text, 'unrelated playlist item dropped').not.toContain('AP Newsminute');
      expect(text, 'unrelated playlist item dropped').not.toContain('Penguins get a new enclosure');

      // 2. Only the on-screen carousel slide survives; the off-screen ones don't.
      expect(text, 'visible slide kept').toContain('At least 3 killed');
      expect(text, 'off-screen slide dropped').not.toContain('Residents look at their ruined home');
      expect(html.match(/\d of 6/g)?.length ?? 0, 'one slide, not six').toBeLessThanOrEqual(1);

      // 3. The player's transport controls go too — they sanitise to a bare
      // glyph + timecode strip that reads as content.
      expect(text, 'timecodes dropped').not.toMatch(/00:42/);

      // The story leads the clip: nothing but the hero media precedes the
      // headline, which is what the regression actually broke.
      const headlineAt = html.indexOf('Russia launches massive drone');
      expect(headlineAt, 'headline present').toBeGreaterThan(-1);
      expect(html.slice(0, headlineAt), 'no rail above the headline').not.toMatch(/newsminute|more videos/i);
    });
  }

});
