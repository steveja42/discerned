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
