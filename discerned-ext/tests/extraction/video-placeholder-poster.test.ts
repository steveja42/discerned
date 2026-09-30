// Guards lazy <video>s whose poster is a site-wide placeholder (deepmind.google).
// Each video's poster is one grey JPEG, the page's own light/dark copies sit
// beside it, and the URL lives in <source data-src> until scrolled to. The clip
// showed a grey box per video, and the three not yet scrolled to vanished.
//
// jsdom has no media or layout, so no frame is grabbed; this checks the
// no-frame outcome: no grey stand-ins, and one link per video to its real URL.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('placeholder video posters', () => {
  it('drops the grey stand-ins and keeps every lazy video', async () => {
    loadFixture('video-placeholder-poster.html', 'https://example.com/blog/lazy-videos/');
    const cap = await captureContext('full-page', { smartArticleDetection: false, stripInlineStyles: false });
    const body = cap.bodyHtml ?? '';

    expect(body, 'no placeholder poster images').not.toContain('video_poster_fallback');
    for (const name of ['clip-one', 'clip-two', 'clip-three']) {
      expect(body, `${name} kept via its data-src URL`)
        .toContain(`https://storage.example.com/media/${name}.mp4`);
    }
    expect(body, 'captions survive').toContain('logical commands');
    expect(body, 'video fallback text not shipped').not.toContain('does not support the video tag');
  });
});
