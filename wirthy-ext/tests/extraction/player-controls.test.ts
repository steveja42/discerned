// Guards removal of VIDEO-PLAYER CONTROL CHROME from captures.
//
// Defect (Facebook reel): the captured clip rendered ~30 stray glyphs in a
// column below the poster frame — play, pause, CC, cast, volume, settings,
// fullscreen, picture-in-picture. None are visible on the source page: a
// player's control layer sits OVER the video (often only on hover), so once the
// <video> is swapped for a poster image the controls are left behind as loose
// icons.
//
// The rule keys on the element's own ACCESSIBLE NAME against the standard
// HTML5-player control vocabulary, so it is generic across players rather than
// per-site — and an ordinary content link that merely contains a control word
// ("Play it again, Sam") is unaffected because the match is anchored.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';

const PROSE = 'This is the real body of the post and it is long enough to be chosen as the content block by the layout finder.';

describe('video-player control chrome', () => {


  it('keeps content links whose text merely contains a control word', async () => {
    // The match is anchored to the WHOLE accessible name, so prose survives.
    document.body.innerHTML = `
      <main><article>
        <p>${PROSE}</p>
        <a href="/x" aria-label="Play it again, Sam - full review">Play it again, Sam</a>
        <a href="/y" aria-label="Settings you should change on your router">Router settings guide</a>
      </article></main>`;

    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const text = cap.bodyText ?? '';
    expect(text, 'a content link is not a player control').toContain('Play it again, Sam');
    expect(text).toContain('Router settings guide');
  });

  it('does not widen its reach to engagement icons it does not name', async () => {
    // "Like" is NOT in the player-control vocabulary, so this rule must leave it
    // alone. (Note "Share"/"Save"/"Follow" ARE dropped, by the pre-existing
    // CHROME_LINK_TEXT_RE pass — that is deliberate and unrelated to this one,
    // so they are not asserted here.)
    document.body.innerHTML = `
      <main><article>
        <p>${PROSE}</p>
        <button aria-label="Like"><svg><path d="M0 0"/></svg></button>
        <span aria-label="Like">20.1K</span>
      </article></main>`;

    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    // aria-label itself does not survive sanitisation, so assert on what the
    // reader sees: the engagement COUNT must still be there. A rule that
    // over-reached to "Like" would take the count's element with it.
    expect(cap.bodyText ?? '', 'engagement count survives').toContain('20.1K');
  });
});
