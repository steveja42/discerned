// Guards play-in-place for a <video> whose source is a direct https media file
// (primal.net's content-addressed .mp4): its poster becomes a tweet-video card
// linking the file, which the web app plays in a native <video>.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('direct-file video', () => {
  it('wraps the poster in a play card linking the media file', async () => {
    loadFixture('video-direct-file.html', 'https://example.com/e/note1');
    const cap = await captureContext('full-page', { smartArticleDetection: false, stripInlineStyles: false });
    const doc = new DOMParser().parseFromString(cap.bodyHtml ?? '', 'text/html');

    const card = doc.querySelector('a.tweet-video[href="https://media.example.com/uploads/abc123.mp4"]');
    expect(card, 'play card links the .mp4').not.toBeNull();
    // Posters are inlined as base64; the real URL survives in data-dx-src.
    const realSrc = (i: Element | null) => i?.getAttribute('data-dx-src') || i?.getAttribute('src') || '';
    expect(realSrc(card!.querySelector('img.tweet-video-poster'))).toContain('frame-one');

    // A posterless video with a stamped thumbnail gets a card whose real URL is that still.
    const thumbCard = doc.querySelector('a.tweet-video[href="https://media.example.com/uploads/def456.mp4"]');
    expect(realSrc(thumbCard!.querySelector('img.tweet-video-poster'))).toBe('https://media.example.com/thumbs/def456.jpg');

    // A blob: stream has nothing to play later, so it never becomes a play card.
    expect(doc.querySelectorAll('a.tweet-video')).toHaveLength(2);
    expect(doc.querySelector('[href^="blob:"], [src^="blob:"]')).toBeNull();
  });
});
