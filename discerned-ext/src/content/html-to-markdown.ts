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

// dx-* marker classes that are pure page chrome (engagement/zap icon rows) with
// no prose value in a long-form article. Collapsing them to text would leak the
// raw icon glyphs, so we remove them wholesale.
const CHROME_MARKER_CLASSES = ['dx-stats', 'dx-zaps-row'];

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

  // Drop pure-chrome dx-* engagement/zap rows entirely.
  td.addRule('drop-dx-chrome', {
    filter: (node) => {
      const cls = node.getAttribute?.('class');
      if (!cls) return false;
      return CHROME_MARKER_CLASSES.some((c) => cls.split(/\s+/).includes(c));
    },
    replacement: () => '',
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
