// Tweet media must survive ALL THE WAY to the published cast:
//   capture → imageUrls (imeta) + bodyText URL paragraphs (kind-1 inline
//   placement) + bodyHtml data-dx-src (kind-30023 markdown placement).
// Regression for the 2026-07-13 report: photo casts rendered their image as a
// top hero instead of in-place, and video casts showed no image at all —
// the markdown dropped every tweet img (base64 src, no data-dx-src) and the
// newest X DOM's bare <video poster> was never extracted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureContext, __setTestHostOverride } from '@/content/capture';
import { htmlToMarkdown } from '@/content/html-to-markdown';
import { createLongFormEvent } from '@/shared/nostr/events';
import type { Evaluation } from '@/shared/types';

const PHOTO_URL = 'https://pbs.twimg.com/media/AAAphoto?format=webp&name=medium';
const POSTER_URL = 'https://pbs.twimg.com/amplify_video_thumb/111/img/poster.jpg';
const TWEET_URL = 'https://x.com/testuser/status/12345';

const EVALUATION: Evaluation = { signal: undefined, qualifiers: [], category: 'General' } as unknown as Evaluation;

function resetDocument(url: string): void {
  document.open();
  document.write('<!doctype html><html><head><title>Test on X</title></head><body></body></html>');
  document.close();
  const u = new URL(url);
  Object.defineProperty(window, 'location', {
    value: {
      href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
      hostname: u.hostname, port: u.port, pathname: u.pathname,
      search: u.search, hash: u.hash, toString() { return u.href; },
    },
    writable: true, configurable: true,
  });
}

/** Legacy-testid tweet with one photo AND a newest-shape bare <video poster>. */
function buildTweetDom(opts: { photo?: boolean; video?: boolean }): void {
  document.body.innerHTML = `
    <article data-testid="tweet">
      <div data-testid="User-Name">
        <a href="/testuser"><span><span>Test User</span></span></a>
      </div>
      <div data-testid="tweetText">Sample tweet text about interesting things.</div>
      ${opts.photo ? `
      <div data-testid="tweetPhoto">
        <img src="${PHOTO_URL}" alt="Image">
      </div>` : ''}
      ${opts.video ? `
      <div class="player-wrap">
        <video poster="${POSTER_URL}" src="blob:https://x.com/xyz"></video>
        <span>0:47</span>
      </div>` : ''}
      <a href="/testuser/status/12345"><time datetime="2026-05-14T23:57:00.000Z">11:57 PM · May 14, 2026</time></a>
    </article>`;
}

/**
 * Newest-shape tweet where each photo sits under an <a aria-label="Image">
 * wrapper. `imgs` is a list of {src} arrays — one array per wrapper, so a
 * wrapper with two entries reproduces X's blur-up placeholder + full-image
 * pair for a SINGLE photo.
 */
function buildNewShapeTweetDom(wrappers: string[][]): void {
  const media = wrappers
    .map(imgs => `<a aria-label="Image">${imgs.map(src => `<img src="${src}">`).join('')}</a>`)
    .join('');
  document.body.innerHTML = `
    <article data-tweet-id="12345">
      <a href="/testuser"><span>Test User</span></a>
      <div data-testid="tweetText">Sample tweet text about interesting things.</div>
      ${media}
      <a href="/testuser/status/12345"><time datetime="2026-05-14T23:57:00.000Z">11:57 PM · May 14, 2026</time></a>
    </article>`;
}

beforeEach(() => {
  resetDocument(TWEET_URL);
  __setTestHostOverride('x.com');
});

afterEach(() => {
  __setTestHostOverride(null);
});

describe('tweet media → cast pipeline', () => {
  it('photo tweet: URL reaches imageUrls, bodyText paragraph, and markdown at the in-card position', async () => {
    buildTweetDom({ photo: true });
    const cap = await captureContext('article');

    expect(cap.bodyHtml).toContain('tweet-card');
    // imeta source
    expect(cap.imageUrls).toEqual([PHOTO_URL]);
    expect(cap.thumbnailUrl).toBe(PHOTO_URL);
    // kind-1 inline placement: the URL is its own paragraph between the tweet
    // text and the date/meta line.
    const paras = (cap.bodyText ?? '').split('\n\n');
    const textIdx = paras.findIndex(p => p.includes('Sample tweet text'));
    const urlIdx = paras.findIndex(p => p.trim() === PHOTO_URL);
    const metaIdx = paras.findIndex(p => p.includes('May 14, 2026'));
    expect(urlIdx, 'photo URL paragraph present').toBeGreaterThan(textIdx);
    expect(metaIdx, 'meta line after the photo').toBeGreaterThan(urlIdx);
    // kind-30023 placement: data-dx-src carries the real URL through
    // htmlToMarkdown as an inline image, positioned after the tweet text.
    expect(cap.bodyHtml).toContain(`data-dx-src="${PHOTO_URL.replace(/&/g, '&amp;')}"`);
    const md = htmlToMarkdown(cap.bodyHtml ?? '');
    expect(md).toContain(`](${PHOTO_URL})`);
    expect(md.indexOf('Sample tweet text')).toBeLessThan(md.indexOf(`](${PHOTO_URL})`));
    // …and survives into the published long-form content.
    const evt = createLongFormEvent(cap, EVALUATION, md);
    expect(evt.content).toContain(PHOTO_URL);
  });

  it('video tweet (bare <video poster>, newest X DOM): poster reaches imageUrls, bodyText, and markdown', async () => {
    buildTweetDom({ video: true });
    const cap = await captureContext('article');

    // The bare-player fallback must find the poster even with no
    // tweetPhoto / videoPlayer containers.
    expect(cap.imageUrls).toEqual([POSTER_URL]);
    expect(cap.thumbnailUrl).toBe(POSTER_URL);
    expect(cap.bodyHtml).toContain('tweet-video-poster');
    expect(cap.bodyHtml).toContain(`data-dx-src="${POSTER_URL}"`);
    // Duration badge found by the upward scan.
    expect(cap.bodyHtml).toContain('0:47');
    // kind-1 paragraph placement.
    const paras = (cap.bodyText ?? '').split('\n\n');
    expect(paras.some(p => p.trim() === POSTER_URL)).toBe(true);
    // kind-30023 markdown keeps the poster inline (as a linked image).
    const md = htmlToMarkdown(cap.bodyHtml ?? '');
    expect(md).toContain(`](${POSTER_URL})`);
    expect(md.indexOf('Sample tweet text')).toBeLessThan(md.indexOf(POSTER_URL));
  });

  it('photo + video tweet: poster first (matches card order), then photo', async () => {
    buildTweetDom({ photo: true, video: true });
    const cap = await captureContext('article');
    expect(cap.imageUrls).toEqual([POSTER_URL, PHOTO_URL]);
    const md = htmlToMarkdown(cap.bodyHtml ?? '');
    expect(md.indexOf(POSTER_URL)).toBeLessThan(md.indexOf(PHOTO_URL));
  });

  // Regression for the VigilantFox single-image report (2026-07-14): both the
  // clip and the cast showed the same photo twice. X ships a single photo as a
  // blur-up placeholder <img> plus the full <img> in one wrapper; the raw
  // wrapper-scan collected both, so a one-photo tweet rendered two identical
  // cells. Dedup by the /media/<ID> stem collapses them (blur-up = name=small,
  // full = name=medium) while leaving genuinely distinct photos alone.
  it('single photo shipped as blur-up + full pair renders ONCE (no duplicate)', async () => {
    const stem = 'https://pbs.twimg.com/media/SAMEID';
    buildNewShapeTweetDom([[`${stem}?format=jpg&name=small`, `${stem}?format=webp&name=medium`]]);
    const cap = await captureContext('article');

    // Only the first-seen src survives into imeta — one image, not two.
    expect(cap.imageUrls).toEqual([`${stem}?format=jpg&name=small`]);
    // …and exactly one photo cell lands in the card body. Count the photo
    // <img> by its data-dx-src carrying the media URL (avatar/badge imgs are
    // inlined data: URIs with no dx-src), so this ignores chrome images.
    const photoImgCount = (cap.bodyHtml?.match(/data-dx-src="https:\/\/pbs\.twimg\.com\/media\//g) ?? []).length;
    expect(photoImgCount, 'blur-up + full collapse to a single card photo').toBe(1);
  });

  it('two genuinely different photos both survive the dedup', async () => {
    const a = 'https://pbs.twimg.com/media/PHOTOA?format=webp&name=medium';
    const b = 'https://pbs.twimg.com/media/PHOTOB?format=webp&name=medium';
    buildNewShapeTweetDom([[a], [b]]);
    const cap = await captureContext('article');
    expect(cap.imageUrls).toEqual([a, b]);
  });
});
