// Role: Content Script — HTML → Markdown converter for long-form (NIP-23) casts
// Description: Converts a clip's sanitised capture HTML (bodyHtml for article/full-page,
//              selectionText for selections) into CommonMark for a kind-30023 event body.
//              Uses turndown for structural fidelity (headings, nested lists, links,
//              blockquotes, code). Two discerned-specific rules: (1) drop data: (base64)
//              images — they are private and would blow past relay event-size limits; only
//              real http(s) image URLs survive as ![alt](url); (2) drop pure-chrome dx-*
//              engagement rows (dx-stats, dx-zaps-row) so icon strips don't leak as stray
//              glyphs. All other dx-* wrappers collapse to their text/links automatically.
// Access: DOM (turndown parses HTML via the ambient document / DOMParser)

import TurndownService from 'turndown';

// dx-* marker classes that are pure page chrome with no prose value in a
// long-form article. Collapsing them to text would leak raw icon glyphs, so we
// remove them wholesale. dx-stats is NOT here — its counts are re-emitted as a
// clean "8 · 528 · 62" row by the dx-stats-counts rule below.
const CHROME_MARKER_CLASSES = ['dx-zaps-row'];

let service: TurndownService | null = null;

function getService(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    linkStyle: 'inlined',
  });

  // Images: publish a real http(s) URL, never a data: URI (private + oversize
  // for relays). The capture pipeline inlines images as base64 in `src` but
  // preserves the original URL in `data-dx-src` (see inlineAllImages). Prefer
  // that; fall back to `src` when it is itself http(s); otherwise drop the image.
  td.addRule('image-real-url', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      // Avatars and icon-sized images are layout chrome, not content — in
      // markdown they'd render full-width (a giant face above every post).
      // The capture pipeline annotates rendered width/height attrs from the
      // live page, so avatar-sized imgs are identifiable here.
      if ((el.getAttribute('alt') ?? '').toLowerCase() === 'avatar') return '';
      if (el.className.split(/\s+/).includes('dx-avatar')) return '';
      const w = parseInt(el.getAttribute('width') ?? '', 10);
      const h = parseInt(el.getAttribute('height') ?? '', 10);
      if (Number.isFinite(w) && Number.isFinite(h) && w <= 72 && h <= 72) return '';
      const dxSrc = el.getAttribute('data-dx-src') ?? '';
      const src = el.getAttribute('src') ?? '';
      const url = /^https?:/i.test(dxSrc)
        ? dxSrc
        : /^https?:/i.test(src)
          ? src
          : '';
      if (!url) return '';
      const alt = (el.getAttribute('alt') ?? '').replace(/\n+/g, ' ');
      return `![${alt}](${url})`;
    },
  });

  // Links, safely. Turndown's built-in rule wraps ANY anchor content in
  // [content](href) — an anchor with block children (primal's quote-note cards,
  // avatar wrappers) produces a link containing blank lines, which is invalid
  // markdown and renders as literal "](https://…)" spills. Never wrap
  // multi-line content; drop links whose content vanished (e.g. an avatar img
  // removed above); keep plain single-line links as real links.
  td.addRule('safe-links', {
    filter: (node) => node.nodeName === 'A',
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      const text = content.trim();
      if (!text) return '';
      if (/\n/.test(text) || !/^https?:/i.test(href)) return content;
      return `[${text}](${href})`;
    },
  });

  // Quoted/embedded note cards (primal's bordered quote is one big <a>):
  // render as a markdown blockquote instead of a link.
  td.addRule('dx-quote-block', {
    filter: (node) => {
      const cls = (node.getAttribute?.('class') ?? '').split(/\s+/);
      return cls.includes('dx-quote') || cls.includes('dx-quote-frag');
    },
    replacement: (content) => {
      const inner = content.trim();
      if (!inner) return '';
      const quoted = inner.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
      return `\n\n${quoted}\n\n`;
    },
  });

  // Post headers / bylines: collapse the name + handle + time link soup into a
  // single bold plain-text line ("**Gigi dergigi.com · 1 mo.**") — no avatar,
  // no profile/timestamp links.
  td.addRule('dx-header-line', {
    filter: (node) => {
      const cls = (node.getAttribute?.('class') ?? '').split(/\s+/);
      return ['dx-header', 'dx-author', 'dx-byline', 'dx-byline-col'].some((c) => cls.includes(c));
    },
    replacement: (_content, node) => {
      const text = ((node as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
      return text ? `\n\n**${text}**\n\n` : '';
    },
  });

  // Engagement rows: re-emit just the counts with separators ("8 · 528 · 62")
  // instead of dropping the row (casts should keep a stat line) or flattening
  // it into glued digits. The counts sit in separate leaf nodes with no
  // whitespace between them (primal: <div><div>8</div></div><div><div>528</div>…),
  // so textContent alone reads "852862" — collect each leaf's own text instead.
  td.addRule('dx-stats-counts', {
    filter: (node) => (node.getAttribute?.('class') ?? '').split(/\s+/).includes('dx-stats'),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const COUNT_RE = /\b\d[\d,.]*[KMB]?\b/i;
      const counts: string[] = [];
      // Every element with no child elements is a leaf; pull the numeric count
      // out of its text (which may carry a leading icon glyph, e.g. "❤ 12").
      el.querySelectorAll('*').forEach((leaf) => {
        if (leaf.children.length > 0) return;
        const m = COUNT_RE.exec((leaf.textContent ?? '').trim());
        if (m) counts.push(m[0]);
      });
      // Fallback: no nested leaves (flat text) — pull every number from the text.
      if (counts.length === 0) {
        const all = (el.textContent ?? '').match(new RegExp(COUNT_RE, 'gi'));
        if (all) counts.push(...all);
      }
      return counts.length > 0 ? `\n\n${counts.join(' · ')}\n\n` : '';
    },
  });

  // Drop pure-chrome dx-* engagement/zap rows entirely.
  td.addRule('drop-dx-chrome', {
    filter: (node) => {
      const cls = node.getAttribute?.('class');
      if (!cls) return false;
      return CHROME_MARKER_CLASSES.some((c) => cls.split(/\s+/).includes(c));
    },
    replacement: () => '',
  });

  // Tweet header: <span class="tweet-name">CIA</span><span class="tweet-handle">
  // @CIA</span> with no whitespace between → "CIA@CIA". Rebuild as
  // "**CIA** @CIA" so name and handle are separated and the avatar (block
  // sibling, dropped by the image rule) doesn't leave a dangling wrapper.
  td.addRule('tweet-header-line', {
    filter: (node) =>
      (node.getAttribute?.('class') ?? '').split(/\s+/).includes('tweet-header'),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const name = (el.querySelector('.tweet-name')?.textContent ?? '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
      const handle = (el.querySelector('.tweet-handle')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const line = [name && `**${name}**`, handle].filter(Boolean).join(' ');
      return line ? `\n\n${line}\n\n` : '';
    },
  });

  // Tweet video: the <a class="tweet-video"> anchor wraps BLOCK children (the
  // play-overlay <div> and duration <span>) — turndown would emit a link whose
  // text contains blank lines, which is invalid markdown and renders as the
  // image followed by a literal "](https://…)" spill. Replace the whole anchor
  // with a clean linked poster image instead.
  td.addRule('tweet-video-poster', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (node.getAttribute?.('class') ?? '').split(/\s+/).includes('tweet-video'),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const img = el.querySelector('img');
      const dxSrc = img?.getAttribute('data-dx-src') ?? '';
      const src = img?.getAttribute('src') ?? '';
      const url = /^https?:/i.test(dxSrc) ? dxSrc : /^https?:/i.test(src) ? src : '';
      if (!url) return '';
      const image = `![Video thumbnail](${url})`;
      const href = el.getAttribute('href') ?? '';
      return `\n\n${/^https?:/i.test(href) ? `[${image}](${href})` : image}\n\n`;
    },
  });

  // Tweet footer: date/views are inline <a>/<span> siblings and each stat is
  // an svg icon (dropped, it has no text) + a bare count span — flattening
  // them concatenates into "202663.5M Views4.9K13K163K44K". Rebuild the line
  // with explicit separators and the stat glyphs the kind-1 body uses.
  td.addRule('tweet-footer-meta', {
    filter: (node) =>
      (node.getAttribute?.('class') ?? '').split(/\s+/).includes('tweet-footer'),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const STAT_EMOJI: Array<[RegExp, string]> = [
        [/repl/i, '💬'], [/repost|retweet/i, '🔁'], [/like/i, '❤️'], [/bookmark/i, '🔖'],
      ];
      const parts: string[] = [];
      el.querySelectorAll('.tweet-date').forEach((d) => {
        const t = (d.textContent ?? '').trim();
        if (t) parts.push(t);
      });
      el.querySelectorAll('.tweet-stat').forEach((s) => {
        const count = (s.querySelector('.tweet-stat-count')?.textContent ?? '').trim();
        if (!count) return;
        const label = s.getAttribute('aria-label') ?? '';
        const emoji = STAT_EMOJI.find(([re]) => re.test(label))?.[1] ?? '';
        parts.push(emoji ? `${emoji} ${count}` : count);
      });
      return parts.length > 0 ? `\n\n${parts.join('  ·  ')}\n\n` : '';
    },
  });

  service = td;
  return td;
}

/**
 * Convert sanitised capture HTML to CommonMark for a kind-30023 body.
 * Returns an empty string for empty/whitespace input.
 */
export function htmlToMarkdown(html: string): string {
  const trimmed = (html ?? '').trim();
  if (trimmed.length === 0) return '';
  const md = getService().turndown(trimmed);
  // Collapse 3+ blank lines to a single blank line separator and trim edges.
  return md.replace(/\n{3,}/g, '\n\n').trim();
}
