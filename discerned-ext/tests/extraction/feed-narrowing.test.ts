// Guards maybeNarrowToVisiblePost — "capture the post you're looking at, not
// the whole endless feed".
//
// Defect: a THREAD and an ENDLESS FEED are structurally identical (repeating
// same-signature siblings under one container), so maybeExpandToFeed widens
// both to the container. Right for a thread, wrong for a feed — an Instagram
// /reels/ capture came out at 106% of the visible page text, carrying 4 reels
// the user never scrolled to.
//
// The numbers below are MEASURED from real pages by
// tests/e2e/tools/feed-post-probe.spec.ts, not invented:
//
//   site                     items  partVis  topShare   want
//   instagram-reels              8        1      0.99   narrow
//   hackernews-thread           22        6      0.22   leave
//   bsky-thread                 53        1      0.33   leave
//   primal-thread                9        0      0.00   leave
//   youtube grid                30        3      0.06   leave
//   instagram profile grid       4        1      0.19   leave
//
// bsky is the load-bearing case: partVis=1 like Instagram, so a visible-count
// test alone would misclassify it and break a pixel-baselined site. topShare is
// what separates them.
//
// jsdom has no layout, so each sibling's box is stubbed to place it relative to
// a 1280x720 viewport.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureContext } from '@/content/capture';

const VW = 1280;
const VH = 720;

const boxes = new WeakMap<Element, { top: number; height: number; width?: number }>();
let originalGCS: typeof window.getComputedStyle;

beforeEach(() => {
  window.innerWidth = VW;
  window.innerHeight = VH;
  document.body.innerHTML = '';

  Element.prototype.getBoundingClientRect = function (this: Element) {
    const b = boxes.get(this);
    if (!b) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const width = b.width ?? 900;
    return {
      width, height: b.height, top: b.top, bottom: b.top + b.height,
      left: 0, right: width, x: 0, y: b.top, toJSON: () => ({}),
    } as DOMRect;
  };

  originalGCS = window.getComputedStyle;
  window.getComputedStyle = ((el: Element) => ({
    position: 'static', zIndex: 'auto', display: 'block', visibility: 'visible',
    opacity: '1', width: '900px', height: '600px', clip: 'auto', clipPath: 'none',
    overflow: 'visible',
  }) as CSSStyleDeclaration) as typeof window.getComputedStyle;
});

afterEach(() => { window.getComputedStyle = originalGCS; });

/**
 * Build a feed/thread: `count` same-signature sibling posts stacked from `startTop`,
 * each `height` tall. Returns the container.
 */
function buildTrack(opts: {
  count: number; height: number; startTop: number; cls: string;
  body: (i: number) => string;
}): HTMLElement {
  const container = document.createElement('div');
  container.className = 'track';
  for (let i = 0; i < opts.count; i++) {
    const post = document.createElement('div');
    post.className = opts.cls;
    post.innerHTML = opts.body(i);
    container.appendChild(post);
    boxes.set(post, { top: opts.startTop + i * opts.height, height: opts.height });
  }
  document.body.appendChild(container);
  boxes.set(container, { top: opts.startTop, height: opts.count * opts.height });
  return container;
}

async function capture(): Promise<string> {
  const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
  return cap.bodyText ?? '';
}

describe('maybeNarrowToVisiblePost — ENDLESS FEED narrows to the visible post', () => {
  it('captures only the on-screen reel (instagram-reels: 8 items, partVis 1, topShare 0.99)', async () => {
    // Each reel is exactly viewport-height and snap-scrolled: reel 0 fills the
    // screen, every other sits fully below it.
    buildTrack({
      count: 8, height: VH, startTop: 0, cls: 'reel',
      body: i => `<video></video><p>REEL_${i}_CAPTION some words about this reel.</p>`,
    });
    const text = await capture();
    expect(text, 'the visible reel is captured').toContain('REEL_0_CAPTION');
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      expect(text, `offscreen reel ${i} must be excluded`).not.toContain(`REEL_${i}_CAPTION`);
    }
  });

  it('follows the user down the feed (reel 2 on screen ⇒ reel 2 captured)', async () => {
    // Same track scrolled two posts down: reels 0-1 are above the viewport.
    buildTrack({
      count: 8, height: VH, startTop: -2 * VH, cls: 'reel',
      body: i => `<video></video><p>REEL_${i}_CAPTION some words about this reel.</p>`,
    });
    const text = await capture();
    expect(text).toContain('REEL_2_CAPTION');
    expect(text).not.toContain('REEL_0_CAPTION');
    expect(text).not.toContain('REEL_3_CAPTION');
  });
});

describe('maybeNarrowToVisiblePost — THREADS and GRIDS are left alone', () => {
  it('keeps the whole thread when several posts share the screen (hackernews: partVis 6, topShare 0.22)', async () => {
    // 22 short comments, ~72px each — six are on screen at once.
    buildTrack({
      count: 22, height: 72, startTop: 0, cls: 'comtr',
      body: i => `<p>COMMENT_${i} this is a reply in the discussion thread with real prose.</p>`,
    });
    const text = await capture();
    // The conversation must survive — this is what the pixel baselines lock in.
    expect(text).toContain('COMMENT_0');
    expect(text).toContain('COMMENT_3');
    expect(text).toContain('COMMENT_10');
  });

  it('keeps the whole thread when ONE post is visible but does not own the viewport (bsky: partVis 1, topShare 0.33)', async () => {
    // The regression case: visible-count alone would narrow this and break a
    // pixel-baselined site. Each card is ~0.33 of the viewport.
    const h = Math.round(VH * 0.33);
    buildTrack({
      count: 53, height: h, startTop: 0, cls: 'css-g5y9jx',
      body: i => `<p>POST_${i} a bluesky post with some text content in it.</p>`,
    });
    const text = await capture();
    expect(text, 'thread must not be narrowed to one post').toContain('POST_0');
    expect(text).toContain('POST_1');
    expect(text).toContain('POST_2');
  });

  it('leaves a video GRID alone (youtube: partVis 3, topShare 0.06)', async () => {
    // Grid rows: several visible, none dominant.
    const h = Math.round(VH * 0.25);
    buildTrack({
      count: 30, height: h, startTop: 0, cls: 'grid-row',
      body: i => `<img><p>VIDEO_${i} title of a video in the channel grid listing.</p>`,
    });
    const text = await capture();
    expect(text).toContain('VIDEO_0');
    expect(text).toContain('VIDEO_1');
  });

  it('does not narrow when only two similar blocks exist (a layout, not a feed)', async () => {
    // FEED_MIN_SIBLINGS guard: two big blocks are a two-column layout.
    buildTrack({
      count: 2, height: VH, startTop: 0, cls: 'panel',
      body: i => `<p>PANEL_${i} this is a large block of page content with prose.</p>`,
    });
    const text = await capture();
    expect(text).toContain('PANEL_0');
  });
});
