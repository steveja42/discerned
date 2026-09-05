// Role: Content Script — HTML → Markdown converter for long-form (NIP-23) casts
// Description: Converts a clip's sanitised capture HTML (bodyHtml for article/full-page,
//              selectionText for selections) into CommonMark for a kind-30023 event body.
//              Uses turndown for structural fidelity (headings, nested lists, links,
//              blockquotes, code) + a GFM table/strikethrough rule (the web feed renders
//              with remarkGfm). Discerned-specific rules: (1) drop data: (base64) images —
//              private + oversize for relays; only real http(s) URLs survive as ![alt](url);
//              (2) drop chrome images (avatars/logos/icons) that would otherwise render
//              full-width; (3) drop pure-chrome dx-* engagement/zap rows; (4) re-emit
//              stat/byline leaf text with separators so name/handle/time/counts don't glue.
//              A DOM pre-pass (separateInlineFacets) re-derives the inline spacing the clip
//              gets from applyFlexSeparation, since that marker never reaches this converter.
//              All other dx-* wrappers collapse to their text/links automatically.
// Access: DOM (turndown parses HTML via the ambient document / DOMParser)

import TurndownService from 'turndown';
import { strikethrough } from 'turndown-plugin-gfm';

// dx-* marker classes that are pure page chrome with no prose value in a
// long-form article. Collapsing them to text would leak raw icon glyphs, so we
// remove them wholesale. dx-stats is NOT here — its counts are re-emitted as a
// clean "8 · 528 · 62" row by the dx-stats-counts rule below.
const CHROME_MARKER_CLASSES = ['dx-zaps-row'];

// Collect the visible text of each LEAF (an element with no child elements, or
// a bare text node) under `el`, in document order. Whitespace-collapsed, empties
// dropped, and adjacent duplicates removed. Used to separate byline/header leaf
// nodes that the source renders with no whitespace between them (name + handle +
// time, YouTube's channel + subscriber rows) — flattening textContent would glue
// them ("Gigidergigi.com"). Dropping adjacent duplicates also collapses the
// repeated facets Bluesky emits (e.g. two identical hashtag <a>s in a row).
function leafTexts(el: HTMLElement): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t && out[out.length - 1] !== t) out.push(t);
  };
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        push(child.textContent ?? '');
      } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
        const child2 = child as Element;
        if (child2.children.length === 0) {
          push(child2.textContent ?? '');
        } else {
          walk(child2);
        }
      }
    }
  };
  walk(el);
  return out;
}

// alt / src-filename tokens that mark an <img> as chrome (avatar, logo, icon,
// badge, favicon, profile picture) rather than article content. Matched against
// both the alt text and the URL's filename stem.
const CHROME_IMG_RE =
  /\b(avatar|logo|icon|favicon|badge|profile[\s_-]?(pic|picture|photo)|user[\s_-]?(pic|image)|emoji|sprite)\b/i;

// Is this <img> layout chrome (avatar/logo/icon) that must NOT become a
// full-width markdown image? Drops:
//  - alt="avatar" (legacy explicit marker) and any alt/filename chrome token;
//  - the img (or an ancestor) tagged dx-avatar, or an ancestor dx-header
//    (header/byline art — the byline text is re-emitted separately);
//  - images the capture annotated as small on the live page (avatar-sized): both
//    width & height ≤ 72 (raised nothing — a genuine 72px content thumbnail is
//    vanishingly rare, and full-width chrome is the worse failure).
function isChromeImage(el: HTMLElement): boolean {
  const alt = (el.getAttribute('alt') ?? '').trim();
  if (alt.toLowerCase() === 'avatar') return true;
  const src = el.getAttribute('data-dx-src') || el.getAttribute('src') || '';
  const rawStem = src.split('?')[0].split('#')[0].split('/').pop() ?? '';
  let fileStem = rawStem;
  try { fileStem = decodeURIComponent(rawStem); } catch { /* keep raw on malformed % escapes */ }
  if (CHROME_IMG_RE.test(alt) || CHROME_IMG_RE.test(fileStem)) return true;
  // dx-avatar on the img itself or any ancestor wrapper; or inside a dx-header.
  if (el.closest?.('.dx-avatar, .dx-header')) return true;
  if (el.className.split(/\s+/).includes('dx-avatar')) return true;
  const w = parseInt(el.getAttribute('width') ?? '', 10);
  const h = parseInt(el.getAttribute('height') ?? '', 10);
  if (Number.isFinite(w) && Number.isFinite(h) && w <= 72 && h <= 72) return true;
  return false;
}

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

  // GFM strikethrough (~~del~~). Not the full `gfm` bundle — task lists /
  // autolinks aren't relevant to captured article HTML and the autolink rule
  // would fight our own safe-links rule.
  td.use(strikethrough);

  // Fenced code for a bare <pre>. Turndown's own fencedCodeBlock rule requires
  // `pre > code` as the FIRST child; a <pre> holding plain text (WordPress /
  // Hackaday shell listings) falls through to default text handling and is
  // emitted UNFENCED — its leading-`#` comment lines then read as ATX headings
  // and render as giant fake section titles in the cast.
  td.addRule('fenced-bare-pre', {
    filter: (node) =>
      node.nodeName === 'PRE' &&
      !(node.firstChild && node.firstChild.nodeName === 'CODE'),
    replacement: (_content, node) => {
      const code = (node.textContent ?? '').replace(/\n$/, '');
      if (code.trim().length === 0) return '';
      // Widen the fence past any backtick run inside the code, as turndown does.
      const longest = (code.match(/`+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `\n\n${fence}\n${code}\n${fence}\n\n`;
    },
  });

  // Tables → GFM. Base turndown has NO <table> rule at all, so without this an
  // infobox (Wikipedia) or any data table flattens into a bare column of cell
  // text. The web renderer loads remarkGfm, so a `| … | … |` GFM table
  // round-trips. We do NOT use turndown-plugin-gfm's `tables` rule because it
  // `keep()`s any table WITHOUT an all-<th> heading row as raw HTML — and
  // ReactMarkdown drops raw HTML, so such a table would VANISH from the cast.
  // Infobox key/value tables almost never have an all-<th> first row. Our rule
  // ALWAYS emits a GFM table, synthesising a blank header row when the source
  // has none (GFM requires a header + delimiter row to render at all).
  td.addRule('gfm-table-always', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length === 0) return '';
      // Cell text, single-lined and pipe-escaped (a literal | would break the
      // column layout). Empty cells become a non-breaking placeholder so the
      // column count stays consistent.
      const cellText = (cell: Element): string =>
        (cell.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
      const rowCells = (tr: Element): string[] =>
        Array.from(tr.querySelectorAll('th, td')).map(cellText);
      const bodyRows = rows.map(rowCells).filter((r) => r.length > 0);
      if (bodyRows.length === 0) return '';
      const cols = Math.max(...bodyRows.map((r) => r.length));
      const pad = (r: string[]): string[] =>
        r.length >= cols ? r.slice(0, cols) : [...r, ...Array(cols - r.length).fill('')];
      // A heading row = the first <tr> is entirely <th>. Otherwise synthesise a
      // blank header (GFM requires a header + delimiter row to render at all).
      const firstTr = rows[0];
      const firstAllTh =
        firstTr.querySelectorAll('th').length > 0 &&
        firstTr.querySelectorAll('td').length === 0;
      const header = firstAllTh ? pad(bodyRows[0]) : Array(cols).fill('');
      const dataRows = firstAllTh ? bodyRows.slice(1) : bodyRows;
      const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
      const out = [
        line(header),
        `| ${Array(cols).fill('---').join(' | ')} |`,
        ...dataRows.map(line),
      ];
      return `\n\n${out.join('\n')}\n\n`;
    },
  });

  // Images: publish a real http(s) URL, never a data: URI (private + oversize
  // for relays). The capture pipeline inlines images as base64 in `src` but
  // preserves the original URL in `data-dx-src` (see inlineAllImages). Prefer
  // that; fall back to `src` when it is itself http(s); otherwise drop the image.
  td.addRule('image-real-url', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      // Avatars, logos, and icon-chrome are layout, not content — in markdown
      // they carry no class/size, so the web renderer draws them full-width (a
      // giant face/logo above every post). Drop them; keep real content images.
      if (isChromeImage(el)) return '';
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
      let text = content.trim();
      if (!text) return '';
      if (/\n/.test(text) || !/^https?:/i.test(href)) return content;
      // Strip block markers the inner content produced. An anchor wrapping a
      // heading (Snapchat /web wraps the avatar AND the username in one link,
      // and the username is an <h3>) collapsed to `[### name](url)`, which
      // renders with a line struck through it. The link is the anchor's job;
      // the heading level is meaningless inside one.
      text = text.replace(/^#{1,6}\s+/, '').replace(/^>\s+/, '').trim();
      if (!text) return '';
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
  // single bold plain-text line ("**Gigi · dergigi.com · 1 mo.**") — no avatar,
  // no profile/timestamp links.
  //
  // The name/handle/time (and YouTube's channel/subscriber rows) sit in separate
  // LEAF nodes with NO whitespace between them, so flattening textContent glues
  // them ("Gigidergigi.com", "jawed6.3M subscribers"). Instead collect each
  // leaf's own text and join with " · " — mirrors the dx-stats-counts leaf-walk.
  td.addRule('dx-header-line', {
    filter: (node) => {
      const cls = (node.getAttribute?.('class') ?? '').split(/\s+/);
      return ['dx-header', 'dx-author', 'dx-byline', 'dx-byline-col'].some((c) => cls.includes(c));
    },
    replacement: (_content, node) => {
      const parts = leafTexts(node as HTMLElement).map((t) => t.replace(/\*/g, ''));
      const joined = parts.join(' · ');
      return joined ? `\n\n**${joined}**\n\n` : '';
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

// Inline elements whose adjacency, with NO whitespace between them, means the
// source glued visually-separated runs. Bluesky renders post bodies as facets —
// hashtags/mentions/links are separate <a>/<span> nodes with no whitespace
// between them (and between paragraphs), so turndown concatenates them into one
// line ("…#TRCMP RCMP#TRCMP…"). The clip fixes this via applyFlexSeparation
// (FLEXSEP_MARKER), but that marker never reaches the markdown converter — so we
// re-derive the same spacing here from inline-element adjacency.
const INLINE_FACET_TAGS = new Set(['A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'MARK', 'ABBR', 'TIME', 'CODE']);

// A hashtag/mention facet — a link or span whose whole text is "#tag" / "@user".
function facetKey(el: Element): string {
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return /^[#@]\S+$/.test(t) ? t.toLowerCase() : '';
}

// DOM pre-pass mirroring applyFlexSeparation for the markdown path: insert a
// space between adjacent inline facet siblings that the source rendered with no
// whitespace between them, and collapse consecutive duplicate hashtag/mention
// facets (Bluesky repeats the same "#tag" <a> back-to-back). Runs on the parsed
// clone before turndown so the converter sees properly separated text.
function separateInlineFacets(root: Element): void {
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    // Skip reconstructed tweet cards — their spacing is already handled by the
    // dedicated tweet-* rules, and their footers pack intentional adjacency.
    if (el.closest?.('[class*="tweet-card"]')) continue;
    const kids = Array.from(el.childNodes);
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i];
      const b = kids[i + 1];
      if (a.nodeType !== 1 || b.nodeType !== 1) continue;
      const ea = a as Element;
      const eb = b as Element;
      if (!INLINE_FACET_TAGS.has(ea.tagName) || !INLINE_FACET_TAGS.has(eb.tagName)) continue;
      // Collapse a consecutive duplicate hashtag/mention facet.
      const ka = facetKey(ea);
      const kb = facetKey(eb);
      if (ka && ka === kb) { eb.remove(); kids.splice(i + 1, 1); i--; continue; }
      const at = ea.textContent ?? '';
      const bt = eb.textContent ?? '';
      if (at.length === 0 || bt.length === 0) continue;
      if (/\s$/.test(at) || /^\s/.test(bt)) continue;
      el.insertBefore(el.ownerDocument!.createTextNode(' '), b);
    }
  }
}

/**
 * Convert sanitised capture HTML to CommonMark for a kind-30023 body.
 * Returns an empty string for empty/whitespace input.
 */
export function htmlToMarkdown(html: string): string {
  const trimmed = (html ?? '').trim();
  if (trimmed.length === 0) return '';
  // Pre-pass: re-derive the inline/facet spacing the clip gets from
  // applyFlexSeparation (its FLEXSEP_MARKER never reaches this string). Parse,
  // separate glued inline facets + collapse duplicate hashtags, re-serialise.
  let source = trimmed;
  try {
    const doc = new DOMParser().parseFromString(`<div id="__dx_md_root">${trimmed}</div>`, 'text/html');
    const container = doc.getElementById('__dx_md_root');
    if (container) {
      separateInlineFacets(container);
      source = container.innerHTML;
    }
  } catch { /* fall back to the raw string if DOMParser is unavailable */ }
  const md = getService().turndown(source);
  // Collapse 3+ blank lines to a single blank line separator and trim edges.
  return md.replace(/\n{3,}/g, '\n\n').trim();
}
