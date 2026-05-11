// Role: Content Script — capture layer
// Description: Five-format clip extractor (selection, article, simplified-article, full-page,
//              bookmark). Sanitises all extracted HTML through a tag/attribute allowlist and
//              inlines images via a privileged background fetch (background → manifest's
//              host_permissions, which already covers <all_urls>). Each capture is assigned a
//              stable UUID so IndexedDB rows and any future kind-30078 mirror correlate cleanly.
// Access: DOM (window.getSelection, window.location, document.title, document.querySelector),
//         chrome.runtime.sendMessage (for INLINE_IMAGE round-trip)

import { Readability } from '@mozilla/readability';
import type { Capture, ClipFormat } from '@/shared/types';
import { LL, log } from '@/shared/logger';


// Known tracking/analytics query parameters to strip from captured URLs.
// Organised by vendor for maintainability.
const TRACKING_PARAMS = new Set([
  // UTM (Universal / Google Analytics)
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  // Google Ads
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  // Microsoft / Bing Ads
  'msclkid',
  // Meta / Facebook
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source',
  // Twitter / X
  'twclid',
  // Instagram
  'igshid',
  // TikTok
  'ttclid',
  // HubSpot
  '_hsenc', '_hsmi', 'hsctaTracking',
  // Mailchimp
  'mc_cid', 'mc_eid',
  // Adobe / Omniture
  's_kwcid', 'ef_id',
  // Yandex
  'yclid', '_openstat',
  // Pinterest
  'epik',
  // LinkedIn
  'li_fat_id',
  // Reddit
  'rdt_cid',
  // Snapchat
  'ScCid',
  // Klaviyo
  '_kx',
  // Drip
  '__s',
]);

/**
 * Remove known tracking/analytics parameters from a URL.
 * Returns the original string unchanged if parsing fails.
 */
export function stripTrackingParams(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const before = parsed.search;
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return before === parsed.search ? rawUrl : parsed.toString();
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `clip_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getPageThumbnail(): string | null {
  const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  if (ogImage) return ogImage;
  const firstImg = document.querySelector<HTMLImageElement>('img');
  return firstImg?.src || null;
}

/**
 * Returns true when the page has at least one selected character.
 */
export function hasSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && sel.toString().trim().length > 0;
}

/**
 * Branch on format and produce a fully-populated Capture. Image-inlining and Readability
 * parsing are async so this returns a Promise.
 */
export async function captureContext(format: ClipFormat): Promise<Capture> {
  switch (format) {
    case 'selection':           return extractSelection();
    case 'article':             return extractArticle();
    case 'simplified-article':  return extractSimplifiedArticle();
    case 'full-page':           return extractFullPage();
    case 'bookmark':            return extractBookmark();
  }
}

function baseFields(): Pick<Capture, 'id' | 'url' | 'title' | 'timestamp'> {
  return {
    id: newId(),
    url: stripTrackingParams(window.location.href),
    title: document.title || 'Untitled Page',
    timestamp: Date.now(),
  };
}

// ── Selection ────────────────────────────────────────────────────────────────

function extractSelection(): Capture {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.toString().trim().length === 0) {
    // Caller should guard against this; degrade gracefully to a bookmark.
    return extractBookmark();
  }

  const range = selection.getRangeAt(0);
  const fragment = wrapFragmentBoundaries(range);
  const sanitized = sanitizeFragment(fragment);
  const context = extractContext(range);

  return {
    ...baseFields(),
    format: 'selection',
    selectionText: sanitized,
    selectionContext: context,
  };
}

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd', 'figcaption',
]);

/**
 * Find the nearest block-level ancestor of a node that is still inside the
 * editable content area (i.e. not body/html). Returns null if none found.
 */
function nearestBlock(node: Node): Element | null {
  let cur: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
  while (cur && cur !== document.body) {
    if (cur.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((cur as Element).tagName.toLowerCase())) {
      return cur as Element;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Wrap the first and last children of a cloned fragment in the block-level
 * tags of their live-DOM ancestors, so a partial selection like "Domain" still
 * comes out as <h1>Domain</h1> rather than a bare text node.
 */
function wrapFragmentBoundaries(range: Range): DocumentFragment {
  const fragment = range.cloneContents();

  const startBlock = nearestBlock(range.startContainer);
  const endBlock = nearestBlock(range.endContainer);

  // Wrap the first child of the fragment if it is a bare text/inline node.
  if (startBlock && fragment.firstChild) {
    const first = fragment.firstChild;
    if (first.nodeType === Node.TEXT_NODE ||
        (first.nodeType === Node.ELEMENT_NODE && !BLOCK_TAGS.has((first as Element).tagName.toLowerCase()))) {
      const wrapper = document.createElement(startBlock.tagName.toLowerCase());
      // Copy class/id so heading levels etc. carry over.
      if (startBlock.className) wrapper.className = startBlock.className;
      wrapper.appendChild(first);
      fragment.insertBefore(wrapper, fragment.firstChild);
    }
  }

  // Wrap the last child of the fragment if it is a bare text/inline node and
  // belongs to a different block than the start.
  if (endBlock && endBlock !== startBlock && fragment.lastChild) {
    const last = fragment.lastChild;
    if (last.nodeType === Node.TEXT_NODE ||
        (last.nodeType === Node.ELEMENT_NODE && !BLOCK_TAGS.has((last as Element).tagName.toLowerCase()))) {
      const wrapper = document.createElement(endBlock.tagName.toLowerCase());
      if (endBlock.className) wrapper.className = endBlock.className;
      wrapper.appendChild(last);
      fragment.appendChild(wrapper);
    }
  }

  return fragment;
}

function extractContext(range: Range): string {
  const CONTEXT_LENGTH = 100;
  try {
    const startContainer = range.startContainer;
    const textContent = startContainer.textContent || '';
    const startOffset = range.startOffset;
    const before = textContent.substring(
      Math.max(0, startOffset - CONTEXT_LENGTH),
      startOffset,
    ).trim();
    const after = textContent.substring(
      range.endOffset,
      Math.min(textContent.length, range.endOffset + CONTEXT_LENGTH),
    ).trim();
    return `...${before} [...] ${after}...`;
  } catch (error) {
    log(LL.WARN, 'Could not extract context:', error, 'url:', window.location.href);
    return '';
  }
}

// ── Bookmark ─────────────────────────────────────────────────────────────────

function extractBookmark(): Capture {
  return {
    ...baseFields(),
    format: 'bookmark',
    thumbnail: getPageThumbnail(),
  };
}

// ── Article (Readability) ────────────────────────────────────────────────────

async function extractArticle(): Promise<Capture> {
  const parsed = parseReadability();
  const base = baseFields();
  if (!parsed) {
    log(LL.WARN, 'Discerned: Readability could not parse this page; falling back to body text.', 'url:', base.url);
    const bodyClone = cloneBodyClean();
    sanitiseTreeInPlace(bodyClone);
    const inlined = await inlineAllImages(bodyClone.innerHTML.trim());
    return {
      ...base,
      format: 'article',
      bodyHtml: inlined,
      bodyText: bodyClone.textContent?.trim() ?? '',
      thumbnail: getPageThumbnail(),
    };
  }

  const sanitized = sanitizeHtmlString(parsed.content);
  const inlined = await inlineAllImages(sanitized);

  return {
    ...base,
    format: 'article',
    title: parsed.title || base.title,
    bodyHtml: inlined,
    bodyText: parsed.textContent.trim(),
    thumbnail: getPageThumbnail(),
  };
}

async function extractSimplifiedArticle(): Promise<Capture> {
  const parsed = parseReadability();
  const base = baseFields();
  if (!parsed) {
    log(LL.WARN, 'Discerned: Readability could not parse this page; falling back to body text.', 'url:', base.url);
    const bodyClone = cloneBodyClean();
    sanitiseTreeInPlace(bodyClone);
    const bodyText = (bodyClone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
    return {
      ...base,
      format: 'simplified-article',
      bodyText,
      thumbnail: getPageThumbnail(),
    };
  }

  // Readability's content is already stripped of ads/nav/clutter — sanitize and
  // store as bodyHtml so the web app can render it with original formatting intact.
  const bodyHtml = sanitizeHtmlString(parsed.content);
  const bodyText = parsed.textContent.replace(/\n{3,}/g, '\n\n').trim();

  return {
    ...base,
    format: 'simplified-article',
    title: parsed.title || base.title,
    bodyHtml,
    bodyText,
    thumbnail: getPageThumbnail(),
  };
}

function parseReadability(): ReturnType<Readability['parse']> | null {
  try {
    // Clone the *rendered* DOM rather than re-parsing outerHTML. outerHTML
    // re-emits noscript blocks and inline scripts that some sites (e.g. FoxNews)
    // use to inject a blocked-page interstitial — DOMParser would then hand
    // Readability the wall instead of the article. document.body.cloneNode(true)
    // reads the live rendered tree (same source full-page capture uses), which
    // the browser has already resolved past those script gates.
    // Avoids document.cloneNode(true) because that produces a Document with
    // __CE_registry=null, crashing CE polyfills in other extensions.
    const clone = document.implementation.createHTMLDocument(document.title);
    const bodyClone = document.body.cloneNode(true) as HTMLElement;
    bodyClone.querySelector('discerned-overlay')?.remove();
    // Remove hidden elements and any node whose text is dominated by known
    // anti-adblock phrases. These nodes score well with Readability because
    // they are clean, short prose — we must excise them before parsing.
    const ADBLOCK_SIGNAL = 'ad or script blocking software';
    bodyClone.querySelectorAll<HTMLElement>('*').forEach(el => {
      const t = el.textContent ?? '';
      if (t.includes(ADBLOCK_SIGNAL)) {
        log(LL.DEBUG, 'Discerned: removing adblock node', el.tagName, el.className, 'url:', window.location.href);
        el.remove();
      }
    });
    log(LL.DEBUG, 'Discerned: parseReadability body char count:', bodyClone.textContent?.length ?? 0, 'url:', window.location.href);
    clone.body.replaceWith(bodyClone);
    // Readability resolves relative URLs against the document location; provide
    // a <base> so links/images in the cloned body resolve correctly.
    const base = clone.createElement('base');
    base.href = document.location.href;
    clone.head.appendChild(base);
    const result = new Readability(clone).parse();
    log(LL.DEBUG, 'Discerned: Readability result title:', result?.title, 'textContent snippet:', result?.textContent?.slice(0, 200), 'url:', window.location.href);
    return result;
  } catch (err) {
    log(LL.WARN, 'Discerned: Readability failed', err, 'url:', window.location.href);
    return null;
  }
}

// ── Full page ────────────────────────────────────────────────────────────────

async function extractFullPage(): Promise<Capture> {
  // Clone the body only — using outerHTML (which includes <html>/<head>) causes
  // DOMParser to restructure the document in ways that leave <script> content as
  // orphaned text nodes that querySelectorAll('script') can't reach.
  const bodyClone = cloneBodyClean();
  sanitiseTreeInPlace(bodyClone);
  const inlined = await inlineAllImages(bodyClone.innerHTML.trim());
  return {
    ...baseFields(),
    format: 'full-page',
    bodyHtml: inlined,
    bodyText: bodyClone.textContent?.trim() ?? '',
    thumbnail: getPageThumbnail(),
  };
}

/**
 * Deep-clone document.body with the Discerned overlay removed so it doesn't
 * contaminate bodyText or bodyHtml captures.
 */
function cloneBodyClean(): HTMLElement {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelector('discerned-overlay')?.remove();
  return clone;
}

// ── Sanitisation ─────────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'a', 'b', 'i', 'em', 'strong', 'p', 'br', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'code', 'pre',
  'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'hr', 'div', 'img',
]);
const ALLOWED_ATTRS_GLOBAL = new Set(['style']);
const ALLOWED_ATTRS_PER_TAG: Record<string, Set<string>> = {
  a:   new Set(['href']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
};

function isSafeImageSrc(src: string): boolean {
  if (src.startsWith('data:image/')) return true;
  if (/^https:\/\//i.test(src)) return true;
  return false;
}

function isSafeHref(href: string): boolean {
  if (/^https?:\/\//i.test(href)) return true;
  if (href.startsWith('#')) return true;
  if (href.startsWith('mailto:')) return true;
  return false;
}

function scrubStyle(value: string): string {
  return value
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/url\s*\(/gi, '')
    .replace(/-moz-binding/gi, '')
    .replace(/behavior\s*:/gi, '');
}

function sanitiseElement(element: Element) {
  const tagName = element.tagName.toLowerCase();

  if (!ALLOWED_TAGS.has(tagName)) {
    element.replaceWith(...Array.from(element.childNodes));
    return;
  }

  const perTag = ALLOWED_ATTRS_PER_TAG[tagName] ?? new Set<string>();

  Array.from(element.attributes).forEach(attr => {
    const name = attr.name.toLowerCase();
    const allowed = ALLOWED_ATTRS_GLOBAL.has(name) || perTag.has(name);
    if (!allowed) { element.removeAttribute(attr.name); return; }

    if (name === 'style') {
      const safe = scrubStyle(attr.value);
      if (safe.trim()) element.setAttribute('style', safe);
      else element.removeAttribute('style');
    } else if (tagName === 'img' && name === 'src') {
      if (!isSafeImageSrc(attr.value)) element.removeAttribute('src');
    } else if (tagName === 'a' && name === 'href') {
      if (!isSafeHref(attr.value)) element.removeAttribute('href');
    }
  });
}

function sanitiseTreeInPlace(root: Element) {
  // Drop dangerous elements outright before walking.
  root.querySelectorAll('script, style, iframe, object, embed, link, meta, noscript').forEach(el => el.remove());

  const walk = (node: Node) => {
    Array.from(node.childNodes).forEach(walk);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    sanitiseElement(node as Element);
  };
  Array.from(root.childNodes).forEach(walk);
}

/**
 * Sanitize a live DocumentFragment (e.g. cloneContents() from a Range) and return safe HTML.
 */
function sanitizeFragment(fragment: DocumentFragment): string {
  const div = document.createElement('div');
  div.appendChild(fragment.cloneNode(true));
  sanitiseTreeInPlace(div);
  return div.innerHTML.trim();
}

/**
 * Sanitize an HTML string (e.g. Readability output, outerHTML) and return safe HTML.
 */
function sanitizeHtmlString(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return '';
  sanitiseTreeInPlace(root);
  return root.innerHTML.trim();
}

// ── Image inlining (background round-trip) ───────────────────────────────────

const INLINE_CONCURRENCY = 8;

const INLINE_IMAGE_TIMEOUT_MS = 5000;

// Round-trip to the background (which has <all_urls> host_permissions) to fetch
// a remote image and return it as a base64 data URI. Falls back to the original
// URL on failure or timeout so a single slow/blocked image never hangs the capture.
async function inlineImage(src: string): Promise<string> {
  if (!src) return src;
  if (src.startsWith('data:')) return src;
  if (!/^https?:/i.test(src)) return src;

  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'INLINE_IMAGE', src }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), INLINE_IMAGE_TIMEOUT_MS),
      ),
    ]);
    if (res?.success && res.data && typeof (res.data as { dataUri?: string }).dataUri === 'string') {
      return (res.data as { dataUri: string }).dataUri;
    }
  } catch {
    // Fall through to original URL.
  }
  return src;
}

async function inlineAllImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return html;

  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length === 0) return html;

  // Resolve relative srcs against the live page (not the synthetic doc).
  const baseUrl = window.location.href;
  const queue = imgs.slice();

  const worker = async () => {
    while (queue.length) {
      const img = queue.shift();
      if (!img) break;
      const raw = img.getAttribute('src');
      if (!raw) continue;
      let abs: string;
      try {
        abs = new URL(raw, baseUrl).toString();
      } catch {
        continue;
      }
      const inlined = await inlineImage(abs);
      img.setAttribute('src', inlined);
    }
  };

  const workers = Array.from({ length: Math.min(INLINE_CONCURRENCY, imgs.length) }, worker);
  await Promise.all(workers);
  return root.innerHTML;
}

// ── Page capability check ────────────────────────────────────────────────────

/**
 * Utility: Check if current page is capturable (i.e. content scripts can run).
 */
export function isCapturablePage(): boolean {
  const url = window.location.href;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('file://')) return false;
  return true;
}
