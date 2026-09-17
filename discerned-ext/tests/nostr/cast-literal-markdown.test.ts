// Guards the three cast-only defects found in the 2026-09-15 corpus sweep
// (remediation plan Phase 6a/6b). All three are invisible in the CLIP — the
// bodyHtml renders correctly and only the markdown conversion is wrong — so no
// clip pixel baseline could have caught them.
//
// Measured across the 206-domain corpus before/after:
//   - indented code blocks holding markdown syntax: 66 -> 0
//   - dx-stats rows discarding prose: 37 domains, ~6.3k chars recovered
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '@/content/html-to-markdown';

// A CommonMark list item whose first line is EMPTY can hold only one blank
// line; content indented 4 spaces after a second blank line therefore falls
// OUT of the list and parses as an indented code block. That is what made
// time.com's "Recommended Stories" and letterboxd's 63 release rows render as
// visible `**bold**` source inside grey code boxes.
describe('block dx-* rules inside a list item', () => {
  it('emits a dx-quote card inline so the item is not an indented code block', () => {
    const md = htmlToMarkdown(
      `<p>Recommended Stories</p><ul><li><a class="dx-quote dx-header" href="https://time.com/a/">` +
        `<img src="data:image/webp;base64,AAA" alt=""><span>Trump Storms Out of NBC Interview</span></a></li></ul>`,
    );
    const item = md.split('\n').find((l) => l.trim().startsWith('-'));
    expect(item, 'the card must stay INSIDE the list item').toBeDefined();
    expect(item).toContain('Trump Storms Out of NBC Interview');
    // No line may be indented 4+ spaces — that is the code-block trigger.
    expect(md.split('\n').some((l) => /^ {4}\S/.test(l))).toBe(false);
  });

  it('emits a dx-byline inline inside a list item', () => {
    const md = htmlToMarkdown(
      `<ul><li><div class="dx-byline"><span>France</span><span>Cannes Film Festival</span></div></li></ul>`,
    );
    expect(md.split('\n').some((l) => /^ {4}\S/.test(l))).toBe(false);
    expect(md).toContain('France');
    expect(md).toContain('Cannes Film Festival');
  });

  // Outside a list item the block form is still what we want.
  it('still emits a blockquote for a dx-quote at top level', () => {
    const md = htmlToMarkdown(`<a class="dx-quote" href="https://x/"><span>quoted note</span></a>`);
    expect(md).toContain('> quoted note');
  });
});

// A <strong> whose last child is a <br> converted to "**Heading\n**" — the
// closing delimiter began a line, so CommonMark never closed the emphasis and
// the heading merged into the paragraph after it (aws-blog's section titles).
describe('emphasis ending in a line break', () => {
  it('closes the bold on its own line', () => {
    const md = htmlToMarkdown(
      `<p><strong>New in agents customers create<br></strong>We’re introducing new capabilities.</p>`,
    );
    expect(md).toContain('**New in agents customers create**');
    expect(md).not.toMatch(/\*\*[^*]*\n\*\*/);
  });
});

// The generic tagger stamps dx-stats on any short flex row of icon-bearing
// children — which a Spotify track row is. dx-stats-counts then reduced it to
// its numbers, turning a 10-track album into "1 · 1, 2 · 2" while the clip
// rendered the tracklist perfectly.
describe('dx-stats rows that carry content', () => {
  const TRACK_ROW =
    `<div class="dx-stats">` +
    `<div><div><span>1</span> <svg viewBox="0 0 24 24"><path d="M0 0z"/></svg></div></div>` +
    `<div><div><a href="https://open.spotify.com/track/1"><div>Speak to Me</div></a>` +
    `<span><a href="https://open.spotify.com/artist/1">Pink Floyd</a></span></div></div>` +
    `<div class="dx-stats"><span><svg viewBox="0 0 16 16"><path d="M0 0z"/></svg></span><div>1:04</div></div>` +
    `</div>`;

  it('keeps the title and artist instead of emitting bare numbers', () => {
    const md = htmlToMarkdown(TRACK_ROW);
    expect(md).toContain('Speak to Me');
    expect(md).toContain('Pink Floyd');
    expect(md).not.toMatch(/^\s*1 · 1\s*$/m);
  });

  it('keeps a timecode whole rather than truncating it to its first number', () => {
    expect(htmlToMarkdown(TRACK_ROW)).toContain('1:04');
  });

  it('emits the row as ONE line, not a paragraph per wrapper', () => {
    const lines = htmlToMarkdown(TRACK_ROW).split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
  });

  // A genuine engagement strip must still collapse to its counts — the whole
  // point of the rule. Its links are icon/verb chrome, never content.
  it('still reduces a real engagement row to counts', () => {
    const md = htmlToMarkdown(
      `<div class="dx-stats">` +
        `<a href="https://github.com/x/watchers">Notifications</a>` +
        `<span><svg viewBox="0 0 16 16"><path d="M0 0z"/></svg><span>13.8k</span></span>` +
        `<span><svg viewBox="0 0 16 16"><path d="M0 0z"/></svg><span>111k</span></span>` +
        `</div>`,
    );
    expect(md).toContain('13.8k');
    expect(md).toContain('111k');
    expect(md).not.toContain('Notifications');
  });
});
