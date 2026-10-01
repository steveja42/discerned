// Guards the Instagram reel play card (user report 2026-09-11: "clips of an
// Instagram reel don't show a main photo … there should be a poster for the
// video file that can be clicked and played in place").
//
// A reel's <video> is ALWAYS a blob: MSE stream, and Instagram renders its own
// full-size cover frame beside it. substituteVideosWithPosters detected that
// frame and simply REMOVED the video — correct (it avoids shipping the same
// frame twice) but it left the cover frame as a flat <img> with no link and no
// play glyph, so the reel could not be played from the clip at all.
//
// Driven through 'full-page' because under jsdom there is no layout, so an
// 'article' capture of this fixture falls through to Readability, which strips
// the <video> before substituteVideosWithPosters ever runs. The live reel path
// has real geometry and takes the layout-finder tier.

import { describe, it, expect, afterEach } from 'vitest';
import { captureContext, __setTestHostOverride, __setTestPathOverride } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const COVER = 'https://scontent.cdninstagram.com/reel-cover-frame.jpg';

describe('Instagram reel poster', () => {
  afterEach(() => { __setTestHostOverride(null); __setTestPathOverride(null); });

  it('wraps the cover frame in a click-to-play card', async () => {
    __setTestHostOverride('www.instagram.com');
    __setTestPathOverride('/reels/DdIpkEaiXt2/');
    loadFixture('instagram-reel.html', 'https://www.instagram.com/reels/DdIpkEaiXt2/?hl=en');
    const cap = await captureContext('full-page', { smartArticleDetection: false, stripInlineStyles: false });
    const body = cap.bodyHtml ?? '';

    // The poster is a play card, not a flat image.
    expect(body, 'poster is wrapped in a play card').toContain('class="tweet-video"');
    expect(body, 'poster carries the play glyph').toContain('tweet-video-play');

    // The href is the SINGULAR /reel/ form — what video-embed.ts resolves to an
    // embeddable player, and what Instagram's own canonical reports.
    expect(body, 'links to the reel permalink')
      .toContain('href="https://www.instagram.com/reel/DdIpkEaiXt2/"');

    // The real URL survives for the cast: htmlToMarkdown drops images whose only
    // source is a data: URI, so without data-dx-src the poster vanishes there.
    expect(body, 'real poster url preserved for the cast').toContain(`data-dx-src="${COVER}"`);

    // The blob: video itself is gone (it is unplayable once detached).
    expect(body, 'blob: video not shipped').not.toContain('<video');
  });
});
