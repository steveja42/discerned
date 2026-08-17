// Guards the feed-post media hoist.
//
// Defect (Instagram reel CLIP, not the cast): the source lays a reel out as two
// columns — the video dominating the frame, the author/caption beside it — but
// in DOM order the caption comes FIRST. A clip is a single column, so the video
// rendered at the very BOTTOM, the opposite of the source's emphasis where the
// video IS the post. (The cast was unaffected: it derives its own image order.)
//
// The hoist is deliberately scoped to posts that maybeNarrowToVisiblePost
// selected. An ARTICLE's images belong exactly where the author placed them, so
// the last test here is the important one: a normal article must never be
// reordered.
//
// jsdom computes no layout, so boxes are stubbed to place the media beside the
// caption the way the live page does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureContext } from '@/content/capture';

const VW = 1280;
const VH = 720;

const boxes = new WeakMap<Element, { top: number; left: number; w: number; h: number }>();
let originalGCS: typeof window.getComputedStyle;

beforeEach(() => {
  window.innerWidth = VW;
  window.innerHeight = VH;
  document.body.innerHTML = '';

  Element.prototype.getBoundingClientRect = function (this: Element) {
    const b = boxes.get(this);
    if (!b) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    return {
      width: b.w, height: b.h, top: b.top, bottom: b.top + b.h,
      left: b.left, right: b.left + b.w, x: b.left, y: b.top, toJSON: () => ({}),
    } as DOMRect;
  };
  originalGCS = window.getComputedStyle;
  window.getComputedStyle = ((): CSSStyleDeclaration => ({
    position: 'static', zIndex: 'auto', display: 'block', visibility: 'visible',
    opacity: '1', width: '900px', height: '600px', clip: 'auto', clipPath: 'none',
    overflow: 'visible',
  }) as CSSStyleDeclaration) as typeof window.getComputedStyle;
});

afterEach(() => { window.getComputedStyle = originalGCS; });

const CAPTION = 'I know I made the transition between feudalism to capitalism a little murky lol but if you want better clarity then you are gonna have to watch my longer videos.';

/**
 * Build a reel feed: `count` full-viewport sibling posts. Each post has the
 * caption FIRST in DOM order and the media second, but positioned BESIDE it —
 * the real Instagram arrangement.
 */
function buildReelFeed(count: number): void {
  const track = document.createElement('div');
  for (let i = 0; i < count; i++) {
    const post = document.createElement('div');
    post.className = 'reel';
    post.innerHTML =
      `<div class="text"><p>POST_${i} ${CAPTION}</p></div>` +
      `<div class="media"><img alt="frame ${i}"></div>`;
    track.appendChild(post);
    const top = i * VH;
    boxes.set(post, { top, left: 0, w: 1200, h: VH });
    // Caption on the LEFT, media on the RIGHT (beside it, same row).
    boxes.set(post.querySelector('.text')!, { top: top + 400, left: 20, w: 300, h: 200 });
    boxes.set(post.querySelector('p')!, { top: top + 400, left: 20, w: 300, h: 200 });
    boxes.set(post.querySelector('.media')!, { top, left: 440, w: 400, h: 700 });
    boxes.set(post.querySelector('img')!, { top, left: 440, w: 400, h: 700 });
  }
  document.body.appendChild(track);
  boxes.set(track, { top: 0, left: 0, w: 1200, h: count * VH });
}

describe('feed-post media hoist', () => {
  it('leads the clip with the reel media even though the caption is first in DOM order', async () => {
    buildReelFeed(6);
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const html = cap.bodyHtml ?? '';
    const imgAt = html.indexOf('<img');
    const textAt = html.indexOf('POST_0');
    expect(imgAt, 'an image is present').toBeGreaterThan(-1);
    expect(textAt, 'the caption is present').toBeGreaterThan(-1);
    expect(imgAt, 'media must come BEFORE the caption').toBeLessThan(textAt);
  });


  it('never reorders an ordinary article (hoist is feed-only)', async () => {
    // The regression that matters: an article's images belong exactly where the
    // author put them. No feed = no narrowing = no hoist.
    const article = document.createElement('article');
    article.innerHTML =
      `<h1>A headline for the story</h1>` +
      `<p>${CAPTION}</p>` +
      `<figure><img alt="inline figure"></figure>` +
      `<p>A second paragraph that follows the figure and continues the article body text.</p>`;
    document.body.appendChild(article);
    boxes.set(article, { top: 0, left: 0, w: 900, h: 1400 });
    article.querySelectorAll('p, h1, figure, img').forEach((el, i) => {
      boxes.set(el, { top: i * 200, left: 0, w: 800, h: 180 });
    });

    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const html = cap.bodyHtml ?? '';
    const h1At = html.indexOf('A headline');
    const imgAt = html.indexOf('<img');
    expect(h1At, 'the headline still leads').toBeGreaterThan(-1);
    expect(imgAt, 'the figure stays where the author put it').toBeGreaterThan(h1At);
  });
});
