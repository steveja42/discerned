// Guards htmlToMarkdown against the cast-rendering defects reported 2026-07-13:
// tweet + primal casts published a kind-30023 whose markdown was malformed —
// giant avatar images, "](https://…)" brace spills from block-content anchors,
// smashed stat digits ("852862"), and duplicate/misplaced media. The published
// markdown is what the PUBLIC feed renders (kind-30023 wins dedup over kind-1),
// and nothing rendered it through a test — so a substring assertion in
// long-form.test.ts passed while the real output was broken.
//
// These tests run the REAL converter over the exact card structures the tweet
// (extractTweet) and primal (tagPrimal) capture paths produce, asserting the
// markdown is well-formed and complete.

import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '@/content/html-to-markdown';

// A native tweet-card with a video (poster via data-dx-src), a photo, and a
// full engagement footer — matches extractTweet's bodyHtml shape.
const TWEET_CARD = `<div class="tweet-card tweet-card--native">
  <div class="tweet-header">
    <img class="tweet-avatar" src="data:image/png;base64,AAAA" alt="CIA" width="48" height="48">
    <div class="tweet-author"><span class="tweet-name">CIA</span><span class="tweet-handle">@CIA</span></div>
  </div>
  <div class="tweet-text">Havana, Cuba</div>
  <a class="tweet-video" href="https://x.com/CIA/status/123" style="max-width:100%">
    <img src="data:image/jpeg;base64,BBBB" alt="Video thumbnail" class="tweet-video-poster" data-dx-src="https://pbs.twimg.com/poster.jpg">
    <div class="tweet-video-play" aria-label="Play video"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
    <span class="tweet-video-duration">0:47</span>
  </a>
  <div class="tweet-photo"><img src="data:image/jpeg;base64,CCCC" alt="Image" data-dx-src="https://pbs.twimg.com/photo1.jpg"></div>
  <div class="tweet-footer"><a class="tweet-date" href="https://x.com/CIA/status/123">11:57 PM · May 14, 2026</a><span class="tweet-date">4.1M Views</span><span class="tweet-stats"><span class="tweet-stat" aria-label="Reply"><svg><path/></svg><span class="tweet-stat-count">1.3K</span></span><span class="tweet-stat" aria-label="Repost"><svg><path/></svg><span class="tweet-stat-count">7K</span></span><span class="tweet-stat" aria-label="Like"><svg><path/></svg><span class="tweet-stat-count">43K</span></span></span></div>
</div>`;

// A primal note-card with an avatar header, an embedded quote-note (one big
// <a class="dx-quote"> with block children), and a dx-stats row whose counts
// live in separate whitespace-less leaf nodes — matches tagPrimal's shape.
const PRIMAL_CARD = `<div class="dx-post">
  <div class="dx-header"><img alt="avatar" src="data:image/png;base64,AAAA" width="42" height="42" data-dx-src="https://r2.primal.net/avatar.jpg"><span>Gigi</span></div>
  <div>Terrible idea. Harmful concept. Users will get rekt.</div>
  <a class="dx-quote" href="https://primal.net/e/note1">
    <div class="dx-header"><img alt="avatar" src="data:image/png;base64,BBBB" width="26" height="26" data-dx-src="https://r2.primal.net/vitor.jpg"><span>Vitor Pamplona</span></div>
    <div>The concept of a public wallet is very interesting and we need to explore more.</div>
  </a>
  <div class="dx-stats"><div><div>8</div></div><div><div>528</div></div><div><div>62</div></div></div>
</div>`;

// Structural invariants every well-formed cast markdown must satisfy. These are
// the exact failure signatures from the bug report.
function assertNoMarkdownDefects(md: string): void {
  // 1. No literal link/image brace spill. A "](url)" is only valid when a "["
  //    opener sits on the SAME line before it (possibly another "]("  from a
  //    nested [![alt](img)](href) between them). If the nearest "[" before the
  //    "](" is on an earlier line, an anchor with block content broke
  //    turndown's link emission and the "](url)" spilled as literal text.
  const lines = md.split('\n');
  for (const line of lines) {
    let searchFrom = 0;
    let closeIdx: number;
    while ((closeIdx = line.indexOf('](', searchFrom)) !== -1) {
      const before = line.slice(0, closeIdx);
      const hasOpener = before.includes('[');
      expect(hasOpener, `brace spill in line "${line.trim()}" — "](" with no "[" opener on the same line`)
        .toBe(true);
      searchFrom = closeIdx + 2;
    }
  }
  // 2. No data: URIs (private + oversize for relays).
  expect(md).not.toContain('data:image');
}

describe('cast markdown — tweet card', () => {
  const md = htmlToMarkdown(TWEET_CARD);

  it('is free of markdown defects (brace spills, data URIs)', () => {
    assertNoMarkdownDefects(md);
  });

  it('separates the author name from the handle', () => {
    // "CIA@CIA" (glued) is the bug; "**CIA** @CIA" is correct.
    expect(md).not.toMatch(/CIA@CIA/);
    expect(md).toMatch(/CIA\*{0,2}\s+@CIA/);
  });

  it('renders the video poster as a nested linked image, no spill', () => {
    // A linked poster is valid nested markdown: [![alt](img)](href).
    expect(md).toContain('[![Video thumbnail](https://pbs.twimg.com/poster.jpg)](https://x.com/CIA/status/123)');
  });

  it('renders the photo inline after the tweet text', () => {
    expect(md).toContain('![Image](https://pbs.twimg.com/photo1.jpg)');
    expect(md.indexOf('Havana')).toBeLessThan(md.indexOf('photo1.jpg'));
  });

  it('keeps a stat row with separators, not smashed digits', () => {
    expect(md).toContain('💬 1.3K');
    expect(md).toContain('🔁 7K');
    expect(md).toContain('❤️ 43K');
    expect(md).toContain('4.1M Views');
    expect(md).toContain('11:57 PM · May 14, 2026');
    // The stats must not glue into "1.3K7K43K".
    expect(md).not.toMatch(/1\.3K7K/);
  });

  it('drops the avatar (never a full-width markdown image)', () => {
    // The only images are the poster + the photo, never the 48px avatar.
    const images = md.match(/!\[[^\]]*\]\([^)]+\)/g) ?? [];
    expect(images).toHaveLength(2);
  });
});

describe('cast markdown — primal note card', () => {
  const md = htmlToMarkdown(PRIMAL_CARD);

  it('is free of markdown defects (brace spills, data URIs)', () => {
    assertNoMarkdownDefects(md);
  });

  it('drops avatars — no images at all in a text-only note', () => {
    expect(md).not.toMatch(/!\[/);
    expect(md).not.toContain('r2.primal.net');
  });

  it('renders the embedded quote-note as a blockquote, not a broken link', () => {
    expect(md).toContain('Vitor Pamplona');
    expect(md).toContain('public wallet');
    // The quote's paragraphs are blockquoted.
    expect(md).toMatch(/^>\s*.*public wallet/m);
    // No "](https://primal.net/e/note1)" spill from the card anchor.
    expect(md).not.toContain('](https://primal.net/e/note1)');
  });

  it('emits the engagement counts separated, not glued ("852862")', () => {
    expect(md).not.toContain('852862');
    expect(md).toContain('8 · 528 · 62');
  });

  it('keeps the primary note body text', () => {
    expect(md).toContain('Terrible idea. Harmful concept.');
  });
});

// ── Finding 2: byline glue — name/handle/time run together ─────────────────
// The name/handle/time (and YouTube channel/subscriber) leaves have NO
// whitespace between them, so flattening textContent glues them.
describe('cast markdown — byline leaf separation', () => {
  it('separates a primal name + handle + time byline with " · "', () => {
    const card = `<div class="dx-post">
      <div class="dx-header"><img class="dx-avatar" alt="avatar" src="data:image/png;base64,AAAA" data-dx-src="https://r2.primal.net/a.jpg"><span>Gigi</span><span>dergigi.com</span><span>1 mo.</span></div>
      <div>Body text here.</div>
    </div>`;
    const md = htmlToMarkdown(card);
    expect(md).not.toContain('Gigidergigi.com');
    expect(md).toContain('**Gigi · dergigi.com · 1 mo.**');
  });

  it('separates a YouTube channel + subscriber byline column', () => {
    const card = `<div class="dx-post">
      <div class="dx-byline-col"><div class="dx-byline-row dx-byline-row--sub"><a href="https://youtube.com/@jawed">jawed</a></div><div class="dx-byline-row dx-byline-row--author">6.3M subscribers</div></div>
      <div>Me at the zoo.</div>
    </div>`;
    const md = htmlToMarkdown(card);
    expect(md).not.toContain('jawed6.3M subscribers');
    expect(md).toContain('**jawed · 6.3M subscribers**');
  });
});

// ── Finding 4: large avatars / logos must not survive as full-width images ──
describe('cast markdown — avatar/logo image drop', () => {
  it('drops a >72px avatar inside a dx-header (no image emitted)', () => {
    const card = `<div class="dx-post">
      <div class="dx-header"><img alt="Profile photo" width="100" height="100" src="data:image/png;base64,AAAA" data-dx-src="https://cdn.example.com/user-avatar-big.jpg"><span>Jane</span></div>
      <div>Some text.</div>
    </div>`;
    const md = htmlToMarkdown(card);
    expect(md).not.toMatch(/!\[/);
    expect(md).not.toContain('user-avatar-big.jpg');
  });

  it('drops an infobox logo by filename even when large (no top logo image)', () => {
    // Wikipedia-infobox-style logo: large, no size attrs, filename says "logo".
    const html = `<div>
      <img src="https://upload.wikimedia.org/Bitcoin_logo.svg" alt="Bitcoin logo">
      <p>Bitcoin is a decentralized digital currency.</p>
    </div>`;
    const md = htmlToMarkdown(html);
    expect(md).not.toContain('Bitcoin_logo.svg');
    expect(md).toContain('decentralized digital currency');
  });

  it('keeps a genuine content image', () => {
    const html = `<figure><img src="https://cdn.example.com/chart-2026.png" alt="revenue chart"></figure>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('![revenue chart](https://cdn.example.com/chart-2026.png)');
  });
});

// ── Finding 5: tables convert to GFM (base turndown drops them) ─────────────
describe('cast markdown — GFM tables', () => {
  it('renders a key/value infobox table as a GFM table (synth header)', () => {
    const html = `<table>
      <tr><td>Symbol</td><td>₿</td></tr>
      <tr><td>Plural</td><td>bitcoins</td></tr>
    </table>`;
    const md = htmlToMarkdown(html);
    // GFM delimiter row proves it's a table, not a flattened column of terms.
    expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
    expect(md).toMatch(/\|\s*Symbol\s*\|\s*₿\s*\|/);
    expect(md).toMatch(/\|\s*Plural\s*\|\s*bitcoins\s*\|/);
    // Never a bare single-column list of terms.
    expect(md).not.toMatch(/^\s*Symbol\s*$/m);
  });

  it('renders a <th> heading-row table with that header', () => {
    const html = `<table>
      <tr><th>Year</th><th>Price</th></tr>
      <tr><td>2020</td><td>$7k</td></tr>
    </table>`;
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/\|\s*Year\s*\|\s*Price\s*\|/);
    expect(md).toMatch(/\|\s*2020\s*\|\s*\$7k\s*\|/);
  });
});

// ── Finding 1: Bluesky facet wall — glued hashtags/mentions ─────────────────
describe('cast markdown — bsky facet separation', () => {
  // Bluesky body: hashtags/mentions are separate inline <a>s with no whitespace
  // between them (and the same tag can repeat back-to-back).
  const BSKY_CARD = `<div class="dx-post">
    <div class="dx-header"><img class="dx-avatar" alt="avatar" src="data:image/png;base64,AAAA"><span>News</span></div>
    <div class="dx-body"><span>Breaking:</span><a href="https://bsky.app/hashtag/TRCMP">#TRCMP</a><a href="https://bsky.app/hashtag/TRCMP">#TRCMP</a><a href="https://bsky.app/hashtag/RCMP">#RCMP</a></div>
  </div>`;
  const md = htmlToMarkdown(BSKY_CARD);

  it('is free of markdown defects', () => {
    assertNoMarkdownDefects(md);
  });

  it('separates adjacent facets instead of gluing them into a wall', () => {
    expect(md).not.toContain('#TRCMP#TRCMP');
    expect(md).not.toContain('#TRCMP#RCMP');
    expect(md).not.toContain('Breaking:#TRCMP');
  });

  it('collapses a consecutive duplicate hashtag facet', () => {
    // "#TRCMP" appears twice back-to-back in the source; only one survives.
    const occurrences = (md.match(/#TRCMP\b/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(md).toContain('#RCMP');
  });
});
