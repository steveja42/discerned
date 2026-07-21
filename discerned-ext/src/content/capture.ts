// Role: Content Script — capture layer
// Description: Four-format clip extractor (selection, article, full-page,
//              bookmark). Sanitises all extracted HTML through a tag/attribute allowlist and
//              inlines images via a privileged background fetch (background → manifest's
//              host_permissions, which already covers <all_urls>). Each capture is assigned a
//              stable UUID so IndexedDB rows and any future kind-30078 mirror correlate cleanly.
// Access: DOM (window.getSelection, window.location, document.title, document.querySelector),
//         chrome.runtime.sendMessage (for INLINE_IMAGE round-trip)

import { Readability } from '@mozilla/readability';
import type { Capture, ClipFormat, EmbeddedTweetData } from '@/shared/types';
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
  'ref_src', 'ref_url',
  'twsrc', 'twcamp', 'twterm', 'twgr', 'twcon',
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

// ── Shadow-DOM helpers ───────────────────────────────────────────────────────
//
// Some sites (Stansberry's Angular app is the reference case) ship article
// content via declarative open Shadow DOM (<template shadowrootmode="open">).
// document.querySelector and window.getSelection do not pierce shadow
// boundaries, so capture-pipeline sites that look at the live DOM for content
// discovery or selection retrieval must descend manually. The clone step also
// has to inline shadow content into the clone, because cloneNode(true) does
// not clone a host's shadow root.
//
// Closed-mode shadow roots are inaccessible to extensions; hasOpenShadow
// returns false for them and we accept that content is invisible.

function hasOpenShadow(el: Element): el is Element & { shadowRoot: ShadowRoot } {
  return !!(el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
}

/**
 * querySelectorAll that pierces OPEN shadow roots. Returns light-DOM matches
 * AND matches from every reachable open shadowRoot under root. Use on the
 * LIVE DOM only; on already-cloned subtrees plain querySelectorAll suffices.
 */
function querySelectorAllDeep(root: ParentNode, selector: string): Element[] {
  const out: Element[] = [];
  const visit = (node: ParentNode) => {
    out.push(...Array.from(node.querySelectorAll(selector)));
    node.querySelectorAll('*').forEach(el => {
      if (hasOpenShadow(el)) visit(el.shadowRoot);
    });
  };
  visit(root);
  return out;
}

/** Walk every element under root including those inside open shadow roots. */
function forEachDeepElement(root: ParentNode, fn: (el: Element) => void): void {
  root.querySelectorAll('*').forEach(el => {
    fn(el);
    if (hasOpenShadow(el)) forEachDeepElement(el.shadowRoot, fn);
  });
}

/**
 * Deep-clone an element, inlining the contents of any OPEN shadow roots as
 * ordinary children of the host clone (after light-DOM children, matching
 * approximate composed rendering order for most widgets). Downstream walkers
 * then see a normal-looking tree. Does NOT resolve <slot> projection; for
 * widgets that use slots, light children appear before inlined shadow
 * children — fine for content widgets that render straight into the shadow.
 */
function deepCloneWithShadow(src: Element): Element {
  const clone = src.cloneNode(false) as Element;
  src.childNodes.forEach(child => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      clone.appendChild(deepCloneWithShadow(child as Element));
    } else {
      clone.appendChild(child.cloneNode(true));
    }
  });
  if (hasOpenShadow(src)) {
    src.shadowRoot.childNodes.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        clone.appendChild(deepCloneWithShadow(child as Element));
      } else {
        clone.appendChild(child.cloneNode(true));
      }
    });
  }
  return clone;
}

/** Closest open shadow-root host ancestor of `node`, or null. Used for logging. */
function shadowHostOf(node: Node | null): Element | null {
  for (let cur = node; cur; cur = (cur as Node).parentNode ?? null) {
    const root = (cur as Node).getRootNode?.();
    if (root && root !== document && (root as ShadowRoot).host) {
      return (root as ShadowRoot).host;
    }
  }
  return null;
}

/**
 * Shadow-aware selection getter. Returns the user's active selection
 * regardless of whether it lives in the light DOM or inside an OPEN shadow
 * root. Chromium exposes Selection on ShadowRoot via shadowRoot.getSelection();
 * we walk open hosts looking for one with a non-empty selection.
 */
function getActiveSelection(): Selection | null {
  const winSel = window.getSelection();
  if (winSel && winSel.toString().trim().length > 0) {
    log(LL.DEBUG, `Discerned: selection found in light DOM (${winSel.toString().length} chars)`, 'url:', window.location.href);
    return winSel;
  }
  // Spec-correct path for selections that cross shadow boundaries:
  // Selection.getComposedRanges({ shadowRoots }) returns StaticRange[] with
  // endpoints inside the supplied open shadow roots. Chromium 134+ supports it.
  const shadowRoots: ShadowRoot[] = [];
  forEachDeepElement(document.body, (el) => {
    if (hasOpenShadow(el)) shadowRoots.push(el.shadowRoot);
  });
  if (!winSel) {
    log(LL.DEBUG, `Discerned: getSelection() returned null; ${shadowRoots.length} open shadow roots on page`, 'url:', window.location.href);
    return null;
  }
  const composedSel = winSel as Selection & {
    getComposedRanges?: (options?: { shadowRoots?: ShadowRoot[] }) => StaticRange[];
  };
  if (typeof composedSel.getComposedRanges !== 'function') {
    if (shadowRoots.length > 0) {
      log(LL.WARN, 'Discerned: Selection.getComposedRanges unavailable (Chromium <134?); cannot reach shadow-root selections', 'url:', window.location.href);
    }
    return winSel;
  }
  const staticRanges = composedSel.getComposedRanges({ shadowRoots });
  log(LL.DEBUG, `Discerned: getComposedRanges returned ${staticRanges.length} range(s) across ${shadowRoots.length} shadow root(s)`, 'url:', window.location.href);
  if (staticRanges.length === 0) return winSel;
  // StaticRange has no cloneContents. Convert to a live Range so downstream
  // selection.getRangeAt(0) + range.cloneContents() works unchanged with
  // endpoints inside a shadow root.
  const sr = staticRanges[0];
  try {
    const liveRange = document.createRange();
    liveRange.setStart(sr.startContainer, sr.startOffset);
    liveRange.setEnd(sr.endContainer, sr.endOffset);
    winSel.removeAllRanges();
    winSel.addRange(liveRange);
    const host = shadowHostOf(sr.startContainer);
    log(LL.DEBUG, `Discerned: selection found inside shadow root of <${host?.tagName.toLowerCase() ?? 'unknown'}> (${liveRange.toString().length} chars)`, 'url:', window.location.href);
    return winSel;
  } catch (err) {
    log(LL.WARN, 'Discerned: failed to convert StaticRange to live Range:', err, 'url:', window.location.href);
    return winSel;
  }
}

type ResolvedSelection =
  | { kind: 'range'; range: Range }
  | { kind: 'text'; text: string };

/**
 * Resolve the working selection for capture. Encapsulates four cases in order
 * of preference:
 *
 *   1. **Shadow-tree selection via getComposedRanges (Chromium 134+).** When
 *      the page has open shadow roots and the selection lives inside one,
 *      Chromium's `selection.getRangeAt(0)` returns a degenerate collapsed
 *      range anchored to the shadow host — its `toString()` is empty even
 *      though `selection.toString()` reports the composed text. The spec API
 *      `Selection.getComposedRanges({ shadowRoots })` returns a `StaticRange`
 *      with endpoints in the actual text nodes inside the shadow tree. We
 *      convert that to a live `Range` so `cloneContents()` works.
 *
 *   2. **Light-DOM selection.** `selection.getRangeAt(0)` works directly.
 *
 *   3. **Cached snapshot from hasSelection().** Falls back if the live
 *      selection was cleared between overlay open and Capture click.
 *
 *   4. **Plain-text fallback.** If we have a non-empty `selection.toString()`
 *      but no usable Range from any of the above (e.g. composed API
 *      unavailable on an older Chromium with a shadow-tree selection), at
 *      least clip the text the user selected. We lose markup but preserve
 *      the user's intent.
 */
function resolveSelection(selection: Selection | null, url: string): ResolvedSelection | null {
  if (!selection) return null;

  // (1) Composed-range path for selections in shadow trees.
  const allShadows: ShadowRoot[] = [];
  forEachDeepElement(document.body, (el) => { if (hasOpenShadow(el)) allShadows.push(el.shadowRoot); });
  const composedSel = selection as Selection & {
    getComposedRanges?: (options?: { shadowRoots?: ShadowRoot[] }) => StaticRange[];
  };
  if (allShadows.length > 0 && typeof composedSel.getComposedRanges === 'function') {
    try {
      const composed = composedSel.getComposedRanges({ shadowRoots: allShadows });
      for (const sr of composed) {
        const live = staticToLiveRange(sr);
        if (live && live.toString().trim().length > 0) {
          const host = shadowHostOf(sr.startContainer);
          log(LL.DEBUG, `Discerned: using composed range from <${host?.tagName.toLowerCase() ?? 'document'}> shadow (${live.toString().length} chars)`, 'url:', url);
          return { kind: 'range', range: live };
        }
      }
    } catch (err) {
      log(LL.WARN, 'Discerned: getComposedRanges threw:', err, 'url:', url);
    }
  }

  // (2) Light-DOM live range.
  if (selection.rangeCount > 0) {
    const live = selection.getRangeAt(0);
    if (live.toString().trim().length > 0) return { kind: 'range', range: live };
  }

  // (3) Snapshot fallback.
  if (isSnapshotUsable(selectionSnapshot)) {
    log(LL.DEBUG, `Discerned: using cached range from hasSelection (${selectionSnapshot.toString().length} chars)`, 'url:', url);
    return { kind: 'range', range: selectionSnapshot };
  }

  // (4) Plain-text last resort — clip selection.toString() even when no
  // usable range survived. Preserves the user's selected text even if markup
  // and image position are lost.
  const text = selection.toString().trim();
  if (text.length > 0) {
    log(LL.WARN, `Discerned: no usable Range — clipping selection.toString() as plain text (${text.length} chars)`, 'url:', url);
    return { kind: 'text', text };
  }

  return null;
}

function staticToLiveRange(sr: StaticRange): Range | null {
  try {
    const live = document.createRange();
    live.setStart(sr.startContainer, sr.startOffset);
    live.setEnd(sr.endContainer, sr.endOffset);
    return live;
  } catch {
    return null;
  }
}

/**
 * Count open and closed shadow roots on the page. Used to emit a single
 * diagnostic log line per capture when shadow content is present, so the
 * console stays quiet on the common (no-shadow) case but informative when
 * a site's capture is potentially affected.
 */
/** Count open shadow roots reachable from `root`. Closed roots are not
 *  detectable from JavaScript without false positives, so we don't try. */
function countShadowRoots(root: ParentNode = document.body): { open: number } {
  let open = 0;
  const visit = (node: ParentNode) => {
    node.querySelectorAll('*').forEach(el => {
      if (hasOpenShadow(el)) {
        open++;
        visit(el.shadowRoot);
      }
    });
  };
  visit(root);
  return { open };
}

/** Emit a one-shot diagnostic log when open shadow roots are present. */
function logShadowPresence(url: string): { open: number } {
  const counts = countShadowRoots();
  if (counts.open === 0) return counts;
  log(LL.DEBUG, `Discerned: ${counts.open} open shadow root(s) detected on page`, 'url:', url);
  return counts;
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
 * Returns true when the page has at least one selected character. Looks inside
 * open shadow roots too (some sites render content there — see Shadow-DOM
 * helpers above).
 */
export function hasSelection(): boolean {
  const sel = getActiveSelection();
  const present = !!sel && sel.toString().trim().length > 0;
  // Snapshot the live range while the user's selection is still intact. Some
  // sites (notably those rendering content in a Web Component shadow root,
  // e.g. Stansberry's Angular widgets) clear the selection as soon as the
  // overlay shadow-DOM is appended to <body> and steals focus. By the time
  // extractSelection runs on the Capture click, the live selection is empty.
  // The snapshot lets extractSelection recover the user's intent.
  if (present && sel && sel.rangeCount > 0) {
    try {
      selectionSnapshot = sel.getRangeAt(0).cloneRange();
    } catch {
      selectionSnapshot = null;
    }
  }
  return present;
}

// Cached at hasSelection() call time, consumed and cleared by extractSelection.
let selectionSnapshot: Range | null = null;

/** True when the snapshot's endpoints are still attached to the live DOM. */
function isSnapshotUsable(r: Range | null): r is Range {
  if (!r) return false;
  const start = r.startContainer;
  const end = r.endContainer;
  return !!(start as Node & { isConnected: boolean }).isConnected &&
         !!(end as Node & { isConnected: boolean }).isConnected &&
         r.toString().trim().length > 0;
}

export interface CaptureOptions {
  /** Skip bare `<article>` elements that look like page containers (have nested articles,
   *  nav/header/footer descendants, or many top-level sections) and hand them to Readability. */
  smartArticleDetection: boolean;
  /** Strip inline style attributes from captured HTML before storing. */
  stripInlineStyles: boolean;
}

/**
 * Branch on format and produce a fully-populated Capture. Image-inlining and Readability
 * parsing are async so this returns a Promise.
 */
export async function captureContext(format: ClipFormat, opts: CaptureOptions = { smartArticleDetection: false, stripInlineStyles: false }): Promise<Capture> {
  let capture: Capture;
  switch (format) {
    case 'selection':           capture = await extractSelection(); break;
    case 'article':             capture = await extractArticle(opts); break;
    case 'full-page':           capture = await extractFullPage(opts); break;
    case 'bookmark':            capture = await extractBookmark(); break;
  }
  selfCheckCapture(capture, format);
  return capture;
}

/**
 * Post-capture self-check (Phase 3.4). Logs a WARN — never throws or alters the
 * capture — when a site-tagger capture came out suspiciously thin, so a broken
 * tagger surfaces in the console / canary output instead of silently shipping a
 * near-empty clip. Two signals, only meaningful when a tagger was active:
 *   1. Zero dx-* markers survived into the body HTML (the tagger stamped
 *      nothing that reached the clip).
 *   2. The captured body text is a tiny fraction of the visible page text
 *      (the tagger mis-scoped the root to a sliver).
 * Cheap and side-effect-free; bookmark format is skipped (metadata-only by
 * design, so "thin" is expected).
 */
function selfCheckCapture(capture: Capture, format: ClipFormat): void {
  if (!siteTaggerActive || format === 'bookmark') return;
  const body = capture.bodyHtml ?? capture.selectionText ?? '';
  const dxMarkers = (body.match(/\bdx-[a-z-]+/g) ?? []).length;
  if (dxMarkers === 0) {
    log(LL.WARN, `Discerned: self-check — site tagger was active but the ${format} clip carries zero dx-* markers (tagger output may not have reached the clip)`, 'url:', capture.url);
  }
  const bodyText = (capture.bodyText ?? '').replace(/\s+/g, ' ').trim();
  const pageText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  // Only judge coverage on pages with enough text for the ratio to mean
  // something; short pages (single tweet, one-line note) legitimately capture
  // most of a small page and would trip a naive threshold.
  if (pageText.length > 2000 && bodyText.length < pageText.length * 0.05) {
    log(LL.WARN, `Discerned: self-check — ${format} clip body text (${bodyText.length} chars) is <5% of page text (${pageText.length} chars); site tagger may have mis-scoped the capture root`, 'url:', capture.url);
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

/** Brief fragment summary: text length + HTML length + element count. */
function fragSummary(frag: DocumentFragment): string {
  const text = (frag.textContent ?? '').length;
  const wrap = document.createElement('div');
  wrap.appendChild(frag.cloneNode(true));
  const html = wrap.innerHTML.length;
  const elems = wrap.querySelectorAll('*').length;
  return `text=${text} html=${html} elems=${elems}`;
}

async function extractSelection(): Promise<Capture> {
  const url = window.location.href;
  logShadowPresence(url);
  // Apply per-site live-DOM tagger so dx-* markers and dx-excl flags land
  // on the live nodes before we clone the selection fragment. The fragment
  // will inherit them via cloneContents().
  siteTaggerActive = applySiteTagger();
  const selection = getActiveSelection();
  const resolved = resolveSelection(selection, url);
  // One-shot: consume the snapshot so a later capture without a fresh
  // hasSelection() call doesn't accidentally reuse it.
  selectionSnapshot = null;
  if (!resolved) {
    log(LL.DEBUG, 'Discerned: extractSelection — no usable selection, falling back to bookmark', 'url:', url);
    return extractBookmark();
  }

  // Plain-text last-resort path: we don't have a Range so we can't run the
  // cloneContents/sanitise pipeline. Wrap the text in a <p> and store directly.
  if (resolved.kind === 'text') {
    const esc = resolved.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return {
      ...baseFields(),
      format: 'selection',
      selectionText: `<p>${esc}</p>`,
      selectionContext: '',
    };
  }

  const range = resolved.range;
  // Annotate <img>s under the range's common ancestor before cloneContents
  // runs inside wrapFragmentBoundaries, so the cloned fragment carries
  // rendered width/height attributes. Over-annotating outside the range is
  // harmless — only images that end up in the fragment matter, and the
  // sizeCleanup runs synchronously.
  const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;

  // On twitter.com / x.com, if the selection lives inside an <article
  // data-testid="tweet">, capture that whole tweet as a tweet-card rather
  // than the bare selected text. Users selecting on x.com almost always
  // want the tweet, not a 12-char span.
  if (ancestor && isTweetHost(url)) {
    const tweetArticle = ancestor.closest('article[data-testid="tweet"]')
      ?? ancestor.closest('article');
    if (tweetArticle) {
      const tweet = await extractTweet(baseFields(), 'selection', tweetArticle);
      if (tweet) {
        log(LL.DEBUG, 'Discerned: selection on x.com — captured whole tweet as tweet-card', 'url:', url);
        return tweet;
      }
      log(LL.DEBUG, 'Discerned: selection on x.com — Tier 0 yielded nothing, falling through', 'url:', url);
    }
  }
  // Pre-harvest embedded tweets within the selection's scope BEFORE markExcluded
  // hides display:none blockquotes (widgets.js leaves them around).
  const harvestedTweets = await harvestEmbeddedTweets(ancestor ?? document);
  const cleanup = markExcluded(document.body);
  const sizeCleanup = ancestor ? annotateLiveImageSizes(ancestor) : () => {};
  const fragment = wrapFragmentBoundaries(range);
  sizeCleanup();
  cleanup();
  log(LL.DEBUG, `Discerned: extractSelection — after cloneContents+wrap: ${fragSummary(fragment)}`, 'url:', url);
  unmarkWrappers(fragment);
  // Promote dx-excl → EXCL_MARKER on the clone, run the site tagger's
  // postClone hook (e.g. Reddit avatar hoist / YT poster swap), then
  // removeMarked. Shared with extractArticle + extractFullPage so all
  // three formats produce the same site-tagger-aware structure.
  applyTaggerToClone(fragment);
  stripSizeMarkers(fragment);
  // Twitter GIFs and videos are <video poster="..."> — convert to <img> so they
  // survive sanitisation (which drops <video> as a non-allowed tag).
  substituteVideosWithPosters(fragment);
  substituteStarRatings(fragment);
  await substituteEmbeddedTweets(fragment, harvestedTweets);
  const sanitized = sanitizeFragment(fragment);
  log(LL.DEBUG, `Discerned: extractSelection — after sanitize: html=${sanitized.length} chars`, 'url:', url);
  const context = extractContext(range);
  const { html: inlined, imageUrls } = await inlineAllImages(sanitized);

  return {
    ...baseFields(),
    format: 'selection',
    selectionText: inlined,
    selectionContext: context,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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

// ── Twitter / X extractor ────────────────────────────────────────────────────
//
// X has shipped two markup shapes we need to read. The "legacy" shape keys
// everything off stable data-testid attributes (User-Name, tweetText,
// Tweet-User-Avatar, ...). A newer shape (seen on x.com mid-2026) dropped
// those testids in favour of Tailwind-ish utility classes with no stable
// hooks except: article[data-tweet-id], aria-label on action buttons, and
// plain <a href="https://x.com/<handle>"> links for the name/handle/avatar.
// extractTweetBlock() below tries the legacy selectors first and falls back
// to the new-shape equivalents so a future X redesign doesn't silently
// degrade the capture to a generic/mispositioned layout again.

/**
 * Build a clean tweet card from Twitter's live DOM using data-testid selectors,
 * which are stable across Twitter's obfuscated class names. Returns null if any
 * required element is missing so the caller can fall through to generic capture.
 */
/** Extract name, badges, text, photos, and video poster from a tweet container element. */
async function extractTweetBlock(root: Element) {
  const userNameEl = root.querySelector<HTMLElement>('[data-testid="User-Name"]');

  // New shape: no [data-testid="User-Name"] wrapper — the name is the first
  // <a href="https://x.com/<handle>"> in the root with non-empty text that
  // doesn't start with "@" (the avatar is also wrapped in a same-href link,
  // but it has no text — filter those out), and the handle is the next such
  // link whose text does start with "@".
  const profileLinks = !userNameEl
    ? Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href^="https://x.com/"], a[href^="/"]'))
        .filter(a => /^(https:\/\/x\.com\/|\/)[A-Za-z0-9_]+$/.test(a.getAttribute('href') ?? ''))
        .filter(a => (a.textContent ?? '').trim().length > 0)
    : [];
  const nameLinkNew = profileLinks.find(a => !(a.textContent ?? '').trim().startsWith('@'));
  const handleLinkNew = profileLinks.find(a => (a.textContent ?? '').trim().startsWith('@'));

  const displayName = userNameEl?.querySelector<HTMLElement>('span > span')?.textContent?.trim()
    ?? nameLinkNew?.textContent?.trim() ?? '';

  // Handle: prefer an <a href="/..."> inside User-Name (outer tweet), fall back to
  // the first @-prefixed span anywhere in the root (quoted tweet's handle is outside User-Name),
  // then the new-shape @handle link.
  const handleFromLink = userNameEl?.querySelector<HTMLAnchorElement>('a[href^="/"]')
    ?.getAttribute('href')?.replace(/^\//, '') ?? '';
  const handleFromSpan = !handleFromLink
    ? Array.from(root.querySelectorAll<HTMLElement>('span'))
        .find(s => s.textContent?.trim().startsWith('@'))
        ?.textContent?.trim().replace(/^@/, '') ?? ''
    : '';
  const handle = handleFromLink || handleFromSpan || handleLinkNew?.textContent?.trim().replace(/^@/, '') || '';

  // Relative time shown in quoted tweets (e.g. "22h")
  const quoteTimeEl = root.querySelector<HTMLElement>('time[datetime]');
  const quoteTime = quoteTimeEl?.textContent?.trim() ?? '';
  const nameLinkEl = userNameEl?.querySelector<HTMLElement>('a[href^="/"]') ?? nameLinkNew ?? null;
  // New shape puts the verified badge as a sibling of the name link, not nested inside it —
  // search the link's parent row too so the badge still gets picked up.
  const badgeScopeEl = nameLinkEl?.parentElement ?? nameLinkEl;
  const badgeEls = badgeScopeEl
    ? Array.from(badgeScopeEl.querySelectorAll<HTMLElement>('img, svg[data-testid="icon-verified"], svg[data-icon^="icon-verified"]'))
    : [];
  const badgeHtmlParts = await Promise.all(badgeEls.map(async (el) => {
    if (el.tagName.toLowerCase() === 'img') {
      const imgEl = el as HTMLImageElement;
      const alt = imgEl.alt ?? '';
      const src = imgEl.src;
      if (!src || !isSafeImageSrc(src)) return alt ? `<span>${alt}</span>` : '';
      const inlined = await inlineImage(src);
      return `<img class="tweet-badge-emoji" src="${inlined}" alt="${alt.replace(/"/g,'&quot;')}" width="16" height="16">`;
    }
    return `<svg class="tweet-badge-verified" viewBox="0 0 22 22" aria-label="Verified" width="16" height="16"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>`;
  }));
  // New shape drops [data-testid="tweetText"]; the body text is the first
  // <div dir="auto"> in the root that isn't inside the name/handle header row.
  const tweetTextEl = root.querySelector<HTMLElement>('[data-testid="tweetText"]')
    ?? Array.from(root.querySelectorAll<HTMLElement>('div[dir="auto"]'))
        .find(el => !el.closest('a[href^="https://x.com/"], a[href^="/"]')) ?? null;
  const sanitisedText = sanitizeHtmlString(tweetTextEl?.innerHTML ?? '');
  const plainText = tweetTextEl?.textContent?.trim() ?? '';
  // Videos: collect ALL video players — tweets can have 2 side-by-side videos.
  // For each tweetPhoto container with a videoPlayer, capture poster, duration, and aspect ratio.
  const photoContainersLegacy = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="tweetPhoto"]'));
  // New shape: each photo/video sits in an <a aria-label="Image"|"View media"> wrapper
  // with no data-testid grouping; use the wrapper itself as the "container".
  const photoContainersNew = photoContainersLegacy.length === 0
    ? Array.from(root.querySelectorAll<HTMLElement>('a[aria-label="Image"], a[aria-label="View media"]'))
    : [];
  const photoContainers = photoContainersLegacy.length > 0 ? photoContainersLegacy : photoContainersNew;

  let videoInfos: VideoInfo[] = photoContainers
    .filter(c => c.querySelector('[data-testid="videoPlayer"], video[poster]'))
    .flatMap(container => {
      const videoEl = container.querySelector<HTMLVideoElement>('[data-testid="videoPlayer"] video[poster], video[poster]');
      const poster = videoEl?.getAttribute('poster') ?? null;
      if (!poster || !isSafeImageSrc(poster)) return [];
      const duration = Array.from(container.querySelectorAll<HTMLElement>('span'))
        .find(s => /^\d+:\d+$/.test(s.textContent?.trim() ?? ''))
        ?.textContent?.trim() ?? null;
      const sizer = container.querySelector<HTMLElement>('[style*="padding-bottom"]');
      const pb = sizer?.style.paddingBottom ?? '';
      const aspectPct = (() => { const v = parseFloat(pb); return Number.isFinite(v) && v > 0 ? v : null; })();
      return [{ poster, duration, aspectPct }];
    });
  // Newest shape: video tweets have NO tweetPhoto / aria-label container at
  // all — the player is a bare <video poster="https://pbs.twimg.com/…"> in the
  // block (its src is a blob: URL). Scan for it directly when the container
  // pass found nothing, walking up a few levels for the "0:47" duration badge.
  if (videoInfos.length === 0) {
    videoInfos = Array.from(root.querySelectorAll<HTMLVideoElement>('video[poster]')).flatMap(videoEl => {
      const poster = videoEl.getAttribute('poster');
      if (!poster || !isSafeImageSrc(poster)) return [];
      let duration: string | null = null;
      let scope: Element | null = videoEl;
      for (let i = 0; i < 4 && scope && !duration; i++) {
        duration = Array.from(scope.querySelectorAll<HTMLElement>('span'))
          .find(s => /^\d+:\d+$/.test(s.textContent?.trim() ?? ''))
          ?.textContent?.trim() ?? null;
        scope = scope.parentElement;
      }
      return [{ poster, duration, aspectPct: null }];
    }).filter((v, i, arr) => arr.findIndex(x => x.poster === v.poster) === i);
  }

  // Photo srcs: only from containers that do NOT contain a video player.
  // Dedup by media stem — a single photo ships a blur-up placeholder <img> plus
  // the full <img> in the same wrapper, which would otherwise render twice.
  const photoSrcs = dedupTweetPhotoSrcs(photoContainers
    .filter(container => !container.querySelector('[data-testid="videoPlayer"], video[poster]'))
    .flatMap(container => Array.from(container.querySelectorAll<HTMLImageElement>('img')))
    .map(img => img.src).filter(isSafeImageSrc));

  return { displayName, handle, quoteTime, badgesHtml: badgeHtmlParts.join(''), sanitisedText, plainText, photoSrcs, videoInfos };
}

type VideoInfo = { poster: string; duration: string | null; aspectPct: number | null };

// data-dx-src carries the REAL http(s) URL alongside the inlined base64 src.
// Without it htmlToMarkdown silently DROPS the image from the published
// kind-30023 markdown (it refuses data: URIs), which is how tweet photos and
// video posters vanished from casts.
function dxSrcAttr(rawUrl: string | undefined): string {
  return rawUrl && /^https?:/i.test(rawUrl)
    ? ` data-dx-src="${rawUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
    : '';
}

function buildSingleVideoHtml(poster: string, rawPoster: string | undefined, duration: string | null, aspectPct: number | null, href: string): string {
  const maxWidth = aspectPct && aspectPct > 100
    ? `${Math.round(100 / (aspectPct / 100))}%`
    : '100%';
  const safeDuration = duration
    ? duration.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : null;
  return `<a class="tweet-video" href="${href}" target="_blank" rel="noopener noreferrer" style="max-width:${maxWidth}">
  <img src="${poster}" alt="Video thumbnail" class="tweet-video-poster"${dxSrcAttr(rawPoster)}>
  <div class="tweet-video-play" aria-label="Play video">
    <svg viewBox="0 0 24 24" width="48" height="48"><path d="M8 5v14l11-7z"/></svg>
  </div>${safeDuration ? `<span class="tweet-video-duration">${safeDuration}</span>` : ''}
</a>`;
}

function buildVideoHtml(inlinedVideos: Array<{ poster: string; rawPoster?: string; duration: string | null; aspectPct: number | null }>, href: string): string {
  if (inlinedVideos.length === 0) return '';
  const items = inlinedVideos.map(v => buildSingleVideoHtml(v.poster, v.rawPoster, v.duration, v.aspectPct, href));
  if (items.length === 1) return items[0];
  // Multiple videos: render in a grid row matching how X shows side-by-side videos.
  return `<div class="tweet-video-grid">${items.join('')}</div>`;
}

/**
 * Dedup tweet photo srcs that point at the SAME underlying media.
 *
 * X renders a single photo as several <img> in one wrapper — a low-res blur-up
 * placeholder plus the full image (the generic blur-up/LQIP pattern the pipeline
 * already handles for other sites in `dedupAdjacentImages`). But the tweet card
 * is a hand-built HTML string assembled directly from a raw wrapper-scan, so it
 * never passes through that sanitise-clone dedup — a one-photo tweet emitted two
 * (or three) identical cells, so the same image showed twice in BOTH the clip
 * and the cast (they derive from this same array).
 *
 * Two pbs.twimg.com URLs are the same photo when their /media/<ID> stem matches
 * even if the ?format=/name= query differs (blur-up = name=small, full =
 * name=medium|large|orig) — the same filename-stem keying `dedupAdjacentImages`
 * uses. Keep the first occurrence of each stem; non-twimg URLs dedup on the full
 * string.
 */
function dedupTweetPhotoSrcs(srcs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of srcs) {
    const m = src.match(/pbs\.twimg\.com\/media\/([^?&#/]+)/i);
    const key = m ? `media:${m[1]}` : src;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

/**
 * Build the photo block for a tweet. X uses count-specific layouts in its
 * embed iframes (1 = single image; 2 = 1×2 row; 3 = 1 tall + 2 stacked;
 * 4 = 2×2). We emit a tweet-photo-grid wrapper with a tweet-photo-grid-N
 * variant so CSS can apply the right layout.
 *
 * Each photo gets the same <div class="tweet-photo"><img></div> shell as
 * before, so single-photo behaviour is unchanged.
 */
function buildPhotosHtml(photos: Array<{ src: string; dxSrc?: string }>): string {
  const valid = photos.filter(p => p.src);
  if (valid.length === 0) return '';
  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const items = valid.map(p => `<div class="tweet-photo"><img src="${safe(p.src)}" alt="Image"${dxSrcAttr(p.dxSrc)}></div>`);
  if (items.length === 1) return items[0];
  const n = Math.min(items.length, 4);
  return `<div class="tweet-photo-grid tweet-photo-grid-${n}">${items.join('')}</div>`;
}

/**
 * Build a tweet-card capture from the primary <article data-testid="tweet">
 * on the current twitter.com / x.com page. `format` controls how the rendered
 * card is plumbed into the Capture shape:
 *   - 'article' / 'full-page' → bodyHtml + bodyText
 *   - 'selection'             → selectionText (selectionContext left empty)
 * `articleOverride` lets selection callers pin a specific tweet article
 * (the one the user's selection lives in), instead of letting the function
 * pick the first one on the page.
 */
async function extractTweet(
  base: Pick<Capture, 'id' | 'url' | 'title' | 'timestamp'>,
  format: 'article' | 'full-page' | 'selection' = 'article',
  articleOverride?: Element,
): Promise<Capture | null> {
  const article = articleOverride
    ?? document.querySelector('article[data-testid="tweet"]')
    ?? document.querySelector('article[data-tweet-id]')
    ?? document.querySelector('article');
  if (!article) return null;

  // Reposter header — [data-testid="socialContext"] lives inside the article's first
  // column (above the tweet body). It contains the reposter's name and a repost SVG.
  const socialCtx = article.querySelector<HTMLElement>('[data-testid="socialContext"]');
  let reposterHtml = '';
  if (socialCtx) {
    const reposterText = socialCtx.textContent?.trim() ?? '';
    const repostSvgEl = socialCtx.querySelector('svg');
    let repostSvgHtml = '';
    if (repostSvgEl) {
      const clone = repostSvgEl.cloneNode(true) as SVGElement;
      clone.removeAttribute('class');
      clone.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));
      repostSvgHtml = clone.outerHTML;
    }
    const safeName = reposterText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    reposterHtml = `<div class="tweet-repost-header">${repostSvgHtml}<span>${safeName}</span></div>`;
    log(LL.DEBUG, `Discerned: repost detected — "${reposterText}"`, 'url:', base.url);
  }

  // Quoted tweet — Twitter wraps it in a [role="link"] block with its own User-Name
  // and tweetText. Swap it out with a comment placeholder while extracting the outer
  // tweet so outer queries don't descend into the quote's elements.
  // The quoted tweet is the only [role="link"] inside the article that also
  // contains a [data-testid="User-Name"] — the outer tweet's User-Name is never
  // inside a role="link" wrapper.
  // Avoid the :has() pseudo-class here — jsdom/nwsapi can throw on it when the
  // tree contains Tailwind-style bracket classes (e.g. "w-[85%]") elsewhere on
  // the page, which real X markup does. Plain traversal + filter is equivalent
  // and doesn't touch the selector engine's :has() path.
  const quoteContainer = Array.from(article.querySelectorAll<HTMLElement>('[role="link"]'))
    .find(el => el.querySelector('[data-testid="User-Name"]') ?? el.querySelector('div[dir="auto"]'));
  const isQuote = !!(quoteContainer?.querySelector('[data-testid="tweetText"], div[dir="auto"]'));
  let quotedHtml = '';
  // Cast metadata for the quoted (embedded older) tweet. The private clip's
  // bodyHtml carries the quote as a rich card, but a public Nostr note can't —
  // so we surface the quote's author, text, and photo URLs here to fold them
  // into the cast's bodyText + imeta tags alongside the outer tweet's.
  let quotedCastMeta: { displayName: string; handle: string; plainText: string; photoUrls: string[] } | null = null;

  if (isQuote && quoteContainer) {
    log(LL.DEBUG, `Discerned: quote tweet detected — "${quoteContainer.querySelector('[data-testid="tweetText"], div[dir="auto"]')?.textContent?.trim().slice(0, 60)}"`, 'url:', base.url);
    const qb = await extractTweetBlock(quoteContainer);
    const qAvatarImg = quoteContainer.querySelector<HTMLImageElement>('[data-testid="Tweet-User-Avatar"] img')
      ?? quoteContainer.querySelector<HTMLImageElement>('a[href^="https://x.com/"] img, a[href^="/"] img');
    const qAvatarSrc = qAvatarImg?.src ?? '';
    const [qAvatar, ...qInlinedRest] = await Promise.all([
      qAvatarSrc && isSafeImageSrc(qAvatarSrc) ? inlineImage(qAvatarSrc) : Promise.resolve(''),
      ...qb.videoInfos.map(v => inlineImage(v.poster)),
      ...qb.photoSrcs.map(inlineImage),
    ]);
    const qInlinedVideoPosters = qInlinedRest.slice(0, qb.videoInfos.length);
    const qPhotos = qInlinedRest.slice(qb.videoInfos.length);
    const qAvatarHtml = qAvatar
      ? `<img class="tweet-avatar tweet-avatar--sm" src="${qAvatar}" alt="${qb.displayName.replace(/"/g,'&quot;')}" width="24" height="24">`
      : '';
    const qSafeName = qb.displayName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const qSafeHandle = qb.handle.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const qSafeTime = qb.quoteTime.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const qPhotosHtml = buildPhotosHtml(qPhotos.map((src, i) => ({ src, dxSrc: qb.photoSrcs[i] })));
    const qInlinedVideoInfos = qb.videoInfos
      .map((v, i) => ({ poster: qInlinedVideoPosters[i] || v.poster, rawPoster: v.poster, duration: v.duration, aspectPct: v.aspectPct }))
      .filter(v => v.poster);
    const qVideoHtml = buildVideoHtml(qInlinedVideoInfos, base.url);
    quotedHtml = `<div class="tweet-quote">
  <div class="tweet-header">
    ${qAvatarHtml}
    <div class="tweet-author">
      <span class="tweet-name">${qSafeName}${qb.badgesHtml}</span>
      <span class="tweet-handle">@${qSafeHandle}${qSafeTime ? ` · <span class="tweet-quote-time">${qSafeTime}</span>` : ''}</span>
    </div>
  </div>
  <div class="tweet-text">${qb.sanitisedText}</div>
  ${qVideoHtml}${qPhotosHtml}
</div>`;
    quotedCastMeta = {
      displayName: qb.displayName,
      handle: qb.handle,
      plainText: qb.plainText,
      photoUrls: qb.photoSrcs.filter(src => /^https?:/i.test(src)),
    };
  } else {
    log(LL.DEBUG, 'Discerned: no quote tweet detected', 'url:', base.url);
  }

  // Swap quote out, extract outer tweet, swap back — keeps the live DOM intact.
  let outerBlock: Awaited<ReturnType<typeof extractTweetBlock>>;
  if (isQuote && quoteContainer) {
    const placeholder = document.createComment('discerned-quote');
    quoteContainer.replaceWith(placeholder);
    outerBlock = await extractTweetBlock(article);
    placeholder.replaceWith(quoteContainer);
  } else {
    outerBlock = await extractTweetBlock(article);
  }

  const { displayName, handle, badgesHtml, sanitisedText } = outerBlock;
  // Photos in the outer tweet only (exclude any inside the quote container)
  const tweetPhotoSrcsLegacy = Array.from(article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img'))
    .filter(img => !quoteContainer?.contains(img))
    .map(img => img.src).filter(isSafeImageSrc);
  // New shape: no [data-testid="tweetPhoto"] grouping — photos sit under
  // <a aria-label="Image"|"View media"> wrappers instead.
  // Dedup by media stem — a single photo ships a blur-up placeholder <img> plus
  // the full <img> in the same wrapper, which would otherwise render twice.
  const tweetPhotoSrcs = dedupTweetPhotoSrcs(tweetPhotoSrcsLegacy.length > 0 ? tweetPhotoSrcsLegacy
    : Array.from(article.querySelectorAll<HTMLImageElement>('a[aria-label="Image"] img, a[aria-label="View media"] img'))
        .filter(img => !quoteContainer?.contains(img))
        .map(img => img.src).filter(isSafeImageSrc));

  // Date/time — legacy: the <time> element and its parent link href.
  // New shape: no <time> element — the date is plain text inside the first
  // <a> below the border divider, e.g. "11:57 PM · May 14, 2026", and the
  // view count lives in the next sibling <a>.
  const timeEl = article.querySelector<HTMLTimeElement>('time[datetime]');
  let dateText = timeEl?.textContent?.trim() ?? '';
  let dateHref = timeEl?.closest('a')?.getAttribute('href') ?? '';
  let viewsText = '';
  if (!timeEl) {
    const statusHref = `/status/`;
    const dateLink = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
      .find(a => !quoteContainer?.contains(a) && /\d{1,2}:\d{2}\s*(AM|PM)/i.test(a.textContent ?? ''));
    if (dateLink) {
      dateText = dateLink.textContent?.trim() ?? '';
      const href = dateLink.getAttribute('href') ?? '';
      dateHref = href.includes(statusHref) ? href : '';
      const viewsLink = dateLink.parentElement?.nextElementSibling?.querySelector('a')
        ?? dateLink.closest('span')?.nextElementSibling?.querySelector('a');
      // The link wraps two spans — a count ("4.1M") and a "Views" label.
      // Take only the count; buildFooterHtml appends its own " Views" suffix.
      viewsText = viewsLink?.querySelector('span')?.textContent?.trim()
        ?? viewsLink?.textContent?.trim() ?? '';
    }
  }

  // Engagement stats — lift each button's SVG icon + count text directly from the DOM.
  // We strip Twitter's obfuscated class names (useless without their stylesheet) but keep
  // viewBox and path data so the icons render correctly with our own sizing CSS.
  const STAT_TESTIDS = ['reply', 'retweet', 'like', 'bookmark'] as const;
  const STAT_ARIA_LABELS: Record<typeof STAT_TESTIDS[number], string> = {
    reply: 'Reply', retweet: 'Repost', like: 'Like', bookmark: 'Bookmark',
  };
  const statItems: Array<{ svg: string; count: string; label: string }> = [];
  for (const testId of STAT_TESTIDS) {
    const btn = article.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?? article.querySelector<HTMLElement>(`button[aria-label="${STAT_ARIA_LABELS[testId]}"]`);
    if (!btn) continue;
    const svgEl = btn.querySelector('svg');
    if (!svgEl) continue;
    const svgClone = svgEl.cloneNode(true) as SVGElement;
    svgClone.removeAttribute('class');
    svgClone.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));
    // Legacy: count lives inside the same button. Mid-2026 shape: a sibling
    // <button aria-label="<digits>">. Newest shape: a sibling <button> with NO
    // aria-label wrapping a <number-flow-react> element whose textContent is
    // the animated count ("1,330" / "4.1K").
    const countElLegacy = btn.querySelector('[data-testid="app-text-transition-container"] span span');
    const siblingBtns = Array.from(btn.parentElement?.querySelectorAll<HTMLElement>('button') ?? [])
      .filter(b => b !== btn);
    const countBtnNew = !countElLegacy
      ? siblingBtns.find(b => /^[\d,.]+[KMB]?$/i.test(b.getAttribute('aria-label') ?? ''))
      : null;
    // number-flow-react is an animated odometer: its open shadow root holds a
    // FULL 0-9 glyph strip per digit slot (textContent is useless — it reads
    // "0123456789"). The actual value lives on each digit slot as the
    // `--current` CSS custom property; separators ("." "," "K") are
    // [part~="symbol"] nodes whose visible glyph is the non-inert child.
    const readNumberFlow = (el: Element): string => {
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!sr) return (el.textContent ?? '').trim();
      let out = '';
      sr.querySelectorAll('[part~="digit"], [part~="symbol"], [part~="prefix"], [part~="suffix"]').forEach(node => {
        const part = node.getAttribute('part') ?? '';
        if (/\bdigit\b/.test(part)) {
          out += (node as HTMLElement).style.getPropertyValue('--current').trim();
        } else {
          const vis = Array.from(node.children).find(c => !c.hasAttribute('inert')) ?? node;
          out += (vis.textContent ?? '').trim();
        }
      });
      return out.trim();
    };
    const countFlowNew = !countElLegacy && !countBtnNew
      ? siblingBtns
          .map(b => b.querySelector('number-flow-react'))
          .filter((el): el is Element => !!el)
          .map(readNumberFlow)
          .find(t => /^[\d,.]+[KMB]?$/i.test(t))
      : undefined;
    const count = countElLegacy?.textContent?.trim()
      ?? countBtnNew?.getAttribute('aria-label')
      ?? countFlowNew
      ?? '';
    statItems.push({
      svg: svgClone.outerHTML,
      count,
      label: btn.getAttribute('aria-label') ?? testId,
    });
  }

  // Avatar
  const avatarImg = article.querySelector<HTMLImageElement>('[data-testid="Tweet-User-Avatar"] img') ??
                    article.querySelector<HTMLImageElement>(`a[href="https://x.com/${handle}"] img, a[href="/${handle}"] img`) ??
                    article.querySelector<HTMLImageElement>('img');
  const avatarSrc = avatarImg?.src ?? '';

  if (!displayName && !sanitisedText) {
    log(LL.DEBUG, 'Discerned: tweet extractor found no name/text, falling through', 'url:', base.url);
    return null;
  }

  const safeDisplayName = displayName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const safeHandle = handle.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Inline avatar + all outer photos + all video posters in parallel
  const [inlinedAvatar, ...inlinedRest] = await Promise.all([
    avatarSrc && isSafeImageSrc(avatarSrc) ? inlineImage(avatarSrc) : Promise.resolve(''),
    ...outerBlock.videoInfos.map(v => inlineImage(v.poster)),
    ...tweetPhotoSrcs.map(src => inlineImage(src)),
  ]);
  const inlinedVideoPosters = inlinedRest.slice(0, outerBlock.videoInfos.length);
  const inlinedPhotos = inlinedRest.slice(outerBlock.videoInfos.length);

  const avatarHtml = inlinedAvatar
    ? `<img class="tweet-avatar" src="${inlinedAvatar}" alt="${safeDisplayName}" width="48" height="48">`
    : '';

  const inlinedVideoInfos = outerBlock.videoInfos
    .map((v, i) => ({ poster: inlinedVideoPosters[i] || v.poster, rawPoster: v.poster, duration: v.duration, aspectPct: v.aspectPct }))
    .filter(v => v.poster);
  const videoHtml = buildVideoHtml(inlinedVideoInfos, base.url);

  const photosHtml = buildPhotosHtml(inlinedPhotos.map((src, i) => ({ src, dxSrc: tweetPhotoSrcs[i] })));

  // Footer: date link + stat buttons (SVG icon + count lifted from Twitter's DOM)
  const safeDate = dateText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const safeDateHref = dateHref.startsWith('/') ? `https://x.com${dateHref}` : '';
  const safeViews = viewsText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dateHtml = safeDate
    ? (safeDateHref
        ? `<a class="tweet-date" href="${safeDateHref}">${safeDate}</a>`
        : `<span class="tweet-date">${safeDate}</span>`)
    : '';
  const viewsHtml = safeViews ? `<span class="tweet-date">${safeViews} Views</span>` : '';
  const statsHtml = statItems.map(({ svg, count, label }) =>
    `<span class="tweet-stat" aria-label="${label.replace(/"/g,'&quot;')}">${svg}${count ? `<span class="tweet-stat-count">${count}</span>` : ''}</span>`
  ).join('');
  const footerHtml = (dateHtml || viewsHtml || statsHtml)
    ? `<div class="tweet-footer">${dateHtml}${viewsHtml}${statsHtml ? `<span class="tweet-stats">${statsHtml}</span>` : ''}</div>`
    : '';

  const bodyHtml = `<div class="tweet-card tweet-card--native">
  ${reposterHtml}
  <div class="tweet-header">
    ${avatarHtml}
    <div class="tweet-author">
      <span class="tweet-name">${safeDisplayName}${badgesHtml}</span>
      <span class="tweet-handle">@${safeHandle}</span>
    </div>
  </div>
  <div class="tweet-text">${sanitisedText}</div>
  ${videoHtml}
  ${photosHtml}
  ${quotedHtml}
  ${footerHtml}
</div>`;

  log(LL.DEBUG, `Discerned: tweet captured — name="${displayName}" handle="@${handle}" photos=${inlinedPhotos.filter(Boolean).length} videos=${inlinedVideoInfos.length} repost=${!!reposterHtml} quoted=${!!quotedHtml} stats=${statItems.length}`, 'url:', base.url);

  // X appends ` https://t.co/… " / X` or just `" / X` to the page title.
  const tweetTitle = base.title
    .replace(/\s+https:\/\/t\.co\/\S+/i, '')  // strip trailing t.co URL
    .replace(/["\s]+\/\s*X\s*$/i, '')          // strip closing `" / X`
    .trim() || base.title;

  // Cast metadata — a public Nostr note can't carry the rich tweet-card, so
  // fold the author, tweet text, engagement counts, and date into the plain
  // bodyText, and expose the photo URLs (real pbs.twimg.com links, not base64)
  // so the cast can publish them as imeta tags + content URLs.
  const STAT_EMOJI: Record<string, string> = { reply: '💬', retweet: '🔁', like: '❤️', bookmark: '🔖' };
  const statsSummary = STAT_TESTIDS
    .map(id => {
      const item = statItems.find(s => (s.label ?? '').toLowerCase().includes(id) || (id === 'retweet' && (s.label ?? '').toLowerCase().includes('repost')));
      return item && item.count ? `${STAT_EMOJI[id]} ${item.count}` : '';
    })
    .filter(Boolean)
    .join('  ·  ');
  const metaLine = [statsSummary, dateText].filter(Boolean).join('  ·  ');
  // Quoted (embedded) tweet — render its author + text as a blockquote so the
  // cast note carries the older post too, not just the outer tweet.
  const quotedBlock = quotedCastMeta
    ? [
        '',
        `> ${quotedCastMeta.displayName} @${quotedCastMeta.handle}`,
        ...quotedCastMeta.plainText.split('\n').map(l => `> ${l}`),
      ].join('\n')
    : '';

  // Media URLs (real pbs.twimg.com links, not base64) in the same order they sit
  // on the card: outer tweet's video posters, then its photos, then the quoted
  // tweet's photos, deduped. Cast as imeta tags AND woven into the body text at
  // the media's position (right after the tweet text, where it sits on the card),
  // so the web app renders each image inline where it appeared instead of
  // stacking them in a top gallery.
  const videoPosterUrls = outerBlock.videoInfos
    .map(v => v.poster)
    .filter(p => /^https?:/i.test(p));
  const imageUrls = [
    ...videoPosterUrls,
    ...tweetPhotoSrcs.filter(src => /^https?:/i.test(src)),
    ...(quotedCastMeta?.photoUrls ?? []),
  ].filter((src, i, arr) => arr.indexOf(src) === i);
  // Only the outer tweet's media go inline before the quote block; the quoted
  // tweet's photos stay in imeta (its blockquote is compact — top-of-quote is
  // close enough) so they don't break the outer tweet's inline flow.
  const outerMediaUrls = imageUrls.filter(u => !(quotedCastMeta?.photoUrls ?? []).includes(u));

  // Assemble the body as blank-line-separated PARAGRAPHS. The web app's inline
  // image rule (renderTextWithBreaks) only swaps a paragraph for its <img> when
  // the whole paragraph is exactly a known image URL — so each media URL must be
  // its own paragraph (blank line above and below), using the SAME string that
  // went into imageUrls so bodyText.includes(url) matches.
  const paragraphs = [
    `${displayName} @${handle}`,
    outerBlock.plainText,
    ...outerMediaUrls,          // one URL per paragraph
    quotedBlock,
    metaLine,
  ].filter(s => s.trim() !== '');
  const plainText = paragraphs.join('\n\n').trim();

  if (format === 'selection') {
    return {
      ...base,
      title: tweetTitle,
      format: 'selection',
      selectionText: bodyHtml,
      selectionContext: '',
      thumbnailUrl: imageUrls[0] ?? null,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    };
  }
  return {
    ...base,
    title: tweetTitle,
    format,
    bodyHtml,
    bodyText: plainText,
    thumbnail: null,
    thumbnailUrl: imageUrls[0] ?? null,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
  };
}

// ── Embedded tweets on third-party pages ────────────────────────────────────
//
// Third-party pages (news sites, blogs) embed tweets in two shapes:
//   1. <blockquote class="twitter-tweet"> — the static fallback with text +
//      author + link. Present even when widgets.js doesn't load.
//   2. <iframe id="twitter-widget-N" src="platform.twitter.com/embed/...">
//      injected by widgets.js after page load. Cross-origin to the host page.
//
// Both shapes are otherwise lost: bare <blockquote> renders as ugly fallback
// text, and <iframe> is removed by the sanitiser's blanket strip. We harvest
// each tweet's data from the LIVE DOM up front (the cross-origin iframe is
// reached via chrome.scripting.executeScript from the background), keyed by
// tweet ID, then replace both shapes in the cloned subtree with a synthesised
// tweet-card div. Photos, avatars, and tweet text from the rendered iframe
// match a Tier 0 (on-twitter.com) capture; the blockquote fallback yields a
// text-only card.

/**
 * Parse a <blockquote class="twitter-tweet"> in the live DOM. Returns null if
 * the element doesn't carry the canonical embed markup. Photos / avatar /
 * video are not present in the blockquote source — those come from the iframe
 * round-trip only.
 */
function parseEmbeddedTweetBlockquote(bq: Element): EmbeddedTweetData | null {
  // Status URL: the LAST <a> whose href points to a tweet status page.
  const statusLinks = Array.from(bq.querySelectorAll<HTMLAnchorElement>('a')).filter(a => {
    const h = a.getAttribute('href') ?? '';
    return /^https?:\/\/(twitter|x)\.com\/[^/]+\/status\/\d+/i.test(h);
  });
  const statusAnchor = statusLinks[statusLinks.length - 1];
  if (!statusAnchor) return null;
  const statusUrl = (statusAnchor.getAttribute('href') ?? '').split('?')[0];
  const tweetIdMatch = statusUrl.match(/\/status\/(\d+)/);
  const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';
  if (!tweetId) return null;

  const dateText = statusAnchor.textContent?.trim() ?? '';

  // Tweet body: the <p> inside the blockquote. Keep inline <a> links.
  const p = bq.querySelector('p');
  const tweetTextHtml = p ? p.innerHTML : '';

  // Author: parse the trailing text node — the canonical embed format is
  //   "— Display Name (@handle) " (with em-dash, hyphen, or en-dash).
  // Collect text nodes that are direct siblings between </p> and <a status>.
  const trailing = (bq.textContent ?? '').replace(/\s+/g, ' ');
  const authorMatch = trailing.match(/[—–-]\s*(.+?)\s+\(@([A-Za-z0-9_]+)\)/);
  let displayName = authorMatch ? authorMatch[1].trim() : '';
  let handle = authorMatch ? authorMatch[2] : '';

  // Fallback: derive handle from the status URL path /{handle}/status/{id}.
  if (!handle) {
    const handleFromUrl = statusUrl.match(/\/(?:twitter|x)\.com\/([^/]+)\/status\//i);
    if (handleFromUrl) handle = handleFromUrl[1];
  }
  if (!displayName && handle) displayName = handle;

  return {
    tweetId,
    statusUrl,
    displayName,
    handle,
    badgesHtml: '',
    tweetTextHtml,
    photoSrcs: [],
    videoInfos: [],
    avatarSrc: '',
    dateText,
    source: 'blockquote',
  };
}

/**
 * Find every <blockquote class="twitter-tweet"> under `scope` (including
 * hidden ones widgets.js leaves behind with display:none) and ask the
 * background to extract rich data from each platform.twitter.com iframe in
 * this tab. Returns a Map keyed by tweet ID with the BEST data we have for
 * each: iframe data wins over blockquote data when both are available.
 */
async function harvestEmbeddedTweets(scope: Document | Element): Promise<Map<string, EmbeddedTweetData>> {
  const merged = new Map<string, EmbeddedTweetData>();

  // Blockquote pass — always runs synchronously on the live DOM so we have a
  // fallback even if the iframe round-trip fails or times out.
  const blockquotes = scope.querySelectorAll<HTMLElement>('blockquote.twitter-tweet');
  blockquotes.forEach(bq => {
    const data = parseEmbeddedTweetBlockquote(bq);
    if (data) merged.set(data.tweetId, data);
  });

  // Iframe pass — round-trip through the background, race against a 1s
  // budget. The background enumerates platform.twitter.com frames in this
  // tab and runs an extractor inside each via chrome.scripting.executeScript.
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'EXTRACT_EMBEDDED_TWEETS' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]);
    if (res?.success && Array.isArray(res.data)) {
      (res.data as EmbeddedTweetData[]).forEach(d => {
        if (d?.tweetId) merged.set(d.tweetId, d);
      });
    }
  } catch (err) {
    log(LL.DEBUG, `harvestEmbeddedTweets: iframe extraction unavailable (${err instanceof Error ? err.message : err}) — using blockquote fallback`, 'url:', window.location.href);
  }

  if (merged.size > 0) {
    const counts = { iframe: 0, blockquote: 0 };
    merged.forEach(d => { counts[d.source]++; });
    log(LL.DEBUG, `harvestEmbeddedTweets: ${merged.size} tweet(s) — iframe=${counts.iframe} blockquote=${counts.blockquote}`, 'url:', window.location.href);
  }

  return merged;
}

function buildStubCard(statusUrl: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'tweet-card tweet-card--embed';
  const footer = document.createElement('div');
  footer.className = 'tweet-footer';
  const link = document.createElement('a');
  link.className = 'tweet-date';
  link.href = statusUrl;
  link.textContent = 'View on X';
  footer.appendChild(link);
  card.appendChild(footer);
  return card;
}

/**
 * Build a tweet-card element from harvested EmbeddedTweetData. Mirrors the
 * Tier 0 card structure ([tweet-card > tweet-header > tweet-avatar + tweet-author;
 * tweet-text; tweet-video; tweet-photo*; tweet-footer]) but with only the
 * fields present in embed sources (no reposter, no quoted tweet, no stats).
 * Photos, avatar, and video posters are inlined to base64 in parallel.
 */
async function buildEmbeddedTweetCard(data: EmbeddedTweetData): Promise<HTMLElement> {
  const safe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  // Inline avatar + all photos + video posters in parallel through the
  // background's privileged fetch. inlineImage falls back to the raw URL on
  // timeout/failure so a single slow image never hangs the capture.
  const [inlinedAvatar, ...inlinedRest] = await Promise.all([
    data.avatarSrc && isSafeImageSrc(data.avatarSrc) ? inlineImage(data.avatarSrc) : Promise.resolve(''),
    ...data.videoInfos.map(v => inlineImage(v.poster)),
    ...data.photoSrcs.map(src => inlineImage(src)),
  ]);
  const inlinedVideoPosters = inlinedRest.slice(0, data.videoInfos.length);
  const inlinedPhotos = inlinedRest.slice(data.videoInfos.length);

  const avatarHtml = inlinedAvatar
    ? `<img class="tweet-avatar" src="${safeAttr(inlinedAvatar)}" alt="${safeAttr(data.displayName)}" width="48" height="48">`
    : '';

  const inlinedVideoInfos = data.videoInfos
    .map((v, i) => ({ poster: inlinedVideoPosters[i] || v.poster, rawPoster: v.poster, duration: v.duration, aspectPct: v.aspectPct }))
    .filter(v => v.poster);
  const videoHtml = buildVideoHtml(inlinedVideoInfos, data.statusUrl);

  const photosHtml = buildPhotosHtml(inlinedPhotos.map((src, i) => ({ src, dxSrc: data.photoSrcs[i] })));

  // Sanitise the embed-iframe's tweetText HTML through the existing
  // sanitiser before injecting it as a string. The card itself is built as
  // a real element (so the rest of the pipeline sees it as a div tree); the
  // tweetText portion is the only string-inserted slice.
  const sanitisedText = sanitizeHtmlString(data.tweetTextHtml);

  const dateHtml = data.dateText
    ? `<a class="tweet-date" href="${safeAttr(data.statusUrl)}">${safe(data.dateText)}</a>`
    : (data.statusUrl ? `<a class="tweet-date" href="${safeAttr(data.statusUrl)}">View on X</a>` : '');

  const html = `<div class="tweet-card tweet-card--embed">
  <div class="tweet-header">
    ${avatarHtml}
    <div class="tweet-author">
      <span class="tweet-name">${safe(data.displayName)}${data.badgesHtml}</span>
      <span class="tweet-handle">@${safe(data.handle)}</span>
    </div>
  </div>
  <div class="tweet-text">${sanitisedText}</div>
  ${videoHtml}
  ${photosHtml}
  ${dateHtml ? `<div class="tweet-footer">${dateHtml}</div>` : ''}
</div>`;

  // Parse the synthesised HTML into a real element so the caller can call
  // replaceWith() on the iframe/blockquote it's substituting.
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild as HTMLElement;
}

/**
 * Replace every embedded-tweet shape (iframe + blockquote) in the cloned
 * subtree with a tweet-card div. Dedupes by tweet ID so a hidden blockquote
 * + visible iframe for the same tweet produces ONE card. Iframes whose ID
 * has no harvested data fall back to a stub "View on X" card so the embed
 * doesn't silently vanish.
 *
 * Must run BEFORE sanitiseTreeInPlace() (which strips iframes outright) and
 * AFTER cloning (we mutate the clone, not the live DOM).
 */
async function substituteEmbeddedTweets(
  root: Element | DocumentFragment,
  harvested: Map<string, EmbeddedTweetData>,
): Promise<void> {
  const seen = new Set<string>();

  // Pass A — iframes first so an iframe-only embed renders even if the
  // blockquote was already stripped by markExcluded (display:none) before
  // cloning. Matches three shapes:
  //   1. <iframe id="twitter-widget-N"> (widgets.js standard render)
  //   2. <iframe src="https://platform.twitter.com/embed/Tweet.html?...id=ID">
  //   3. Host-page wrappers like Breitbart's tweet-5.html#ID (and similar
  //      sites that re-wrap the standard widget) — tweet ID lives in the
  //      URL fragment.
  const iframes = Array.from(root.querySelectorAll('iframe')) as HTMLIFrameElement[];
  for (const iframe of iframes) {
    const id = iframe.getAttribute('id') ?? '';
    const src = iframe.getAttribute('src') ?? '';
    const dataTweetId = iframe.getAttribute('data-tweet-id') ?? '';
    // Host-page wrappers expose the tweet ID in the URL fragment. Common
    // shapes: "/tweet-5.html#2061814497598169130" or
    // "/tweet-5.html#2061814497598169130-onlyvideo".
    const wrapperHostPattern = /\/(tweet|status|x-embed)[^\/]*\.html#/i;
    const isTweetEmbed = /^twitter-widget/i.test(id)
      || /platform\.twitter\.com\/embed/i.test(src)
      || wrapperHostPattern.test(src)
      || dataTweetId.length > 0;
    if (!isTweetEmbed) continue;

    let tweetId = dataTweetId;
    if (!tweetId && src) {
      const qIdx = src.indexOf('?');
      if (qIdx >= 0) {
        const idParam = new URLSearchParams(src.slice(qIdx + 1)).get('id');
        if (idParam) tweetId = idParam;
      }
      // Fragment fallback (Breitbart-style): "...#ID" or "...#ID-onlyvideo".
      if (!tweetId) {
        const hashIdx = src.indexOf('#');
        if (hashIdx >= 0) {
          const fragMatch = src.slice(hashIdx + 1).match(/^(\d{6,})/);
          if (fragMatch) tweetId = fragMatch[1];
        }
      }
    }
    if (!tweetId) { iframe.remove(); continue; }

    const data = harvested.get(tweetId);
    const card = data
      ? await buildEmbeddedTweetCard(data)
      : buildStubCard(`https://x.com/i/status/${tweetId}`);
    iframe.replaceWith(card);
    seen.add(tweetId);
  }

  // Pass B — blockquotes. Dedupe against Pass A.
  const blockquotes = Array.from(root.querySelectorAll('blockquote.twitter-tweet')) as HTMLElement[];
  for (const bq of blockquotes) {
    // Resolve to a tweet ID first so the dedupe check works regardless of
    // whether we have harvested data for it.
    const inlineParsed = parseEmbeddedTweetBlockquote(bq);
    if (!inlineParsed) { bq.remove(); continue; }
    if (seen.has(inlineParsed.tweetId)) { bq.remove(); continue; }
    const data = harvested.get(inlineParsed.tweetId) ?? inlineParsed;
    bq.replaceWith(await buildEmbeddedTweetCard(data));
    seen.add(inlineParsed.tweetId);
  }
}

// ── Article (Readability) ────────────────────────────────────────────────────

// Selectors tried in order to find the article content element on the live page.
// The first match with enough text content wins; Readability is used if none match.
const ARTICLE_SELECTORS = [
  'article',
  '[role="article"]',
  'main article',
  'main',
  '[role="main"]',
];
const ARTICLE_MIN_CHARS = 200;

/**
 * Returns true when an article element looks like a page-level container rather
 * than a focused piece of content. Checked only when smartArticleDetection is on.
 *
 * Signals (any one is sufficient):
 *   1. Contains nested <article> elements — it's a feed/list, not a single piece.
 *   2. Contains a <nav> descendant — page chrome leaked into the article.
 *   3. Contains a top-level <header> or <footer> — structural page sections inside.
 *   4. Has ≥ 3 direct <section> children — more like a hub page than an article.
 */
function looksLikeContainer(el: Element): boolean {
  if (el.querySelector('article')) return true;
  if (el.querySelector('nav')) return true;
  // <article> itself often wraps a semantic <header>/<footer> (title + byline +
  // figure on top; share buttons + categories on bottom). News sites and
  // generic WordPress themes (Breitbart, NYT, WaPo) all use this pattern.
  // Only treat header/footer as a container signal when the element ITSELF
  // is not <article> — for a <main> or <div> with a sibling header/footer,
  // the structural sections are page chrome.
  if (el.tagName.toLowerCase() !== 'article' &&
      el.querySelector(':scope > header, :scope > footer')) return true;
  const directSections = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'section');
  if (directSections.length >= 3) return true;
  return false;
}

function findArticleElement(smartDetection: boolean): Element | null {
  for (const sel of ARTICLE_SELECTORS) {
    const el = querySelectorAllDeep(document.body, sel)[0] ?? null;
    if (!el || (el.textContent ?? '').trim().length < ARTICLE_MIN_CHARS) continue;
    if (smartDetection && looksLikeContainer(el)) {
      log(LL.DEBUG, `Discerned: skipping <${el.tagName.toLowerCase()}> (looks like container) — falling to Readability`, 'url:', window.location.href);
      return null;
    }
    return el;
  }
  return null;
}

// ── Layout-based content-block finder ────────────────────────────────────────
//
// Many modern SPAs (Nostr clients, Mastodon, Bluesky, Threads, Lemmy, Reddit's
// new UI) render entirely as <div> soup with hashed class names — none of the
// ARTICLE_SELECTORS match, and Readability (tuned for blog/news prose) tends to
// give up and return a tiny subtree. This heuristic picks the best content
// element by *visual layout* instead of markup semantics: the largest block in
// the page's central column that contains real prose (not just buttons/icons).

const LAYOUT_MIN_TEXT_CHARS = 200;
const LAYOUT_MAX_LINK_TEXT_RATIO = 0.85; // dominated by link text = nav/feed of cards
const LAYOUT_MAX_BUTTON_DENSITY = 0.15; // buttons/textLength — high = UI chrome
const LAYOUT_SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside',
  'svg', 'path', 'button', 'input', 'select', 'textarea', 'form', 'iframe',
  // Content leaves — picking one of these means we miss siblings. Prefer the
  // container (article, main, div, section) that holds them.
  'p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code',
]);

interface BlockScore {
  el: Element;
  score: number;
  textLen: number;
  width: number;
  height: number;
}

/**
 * Score an element as a candidate content block. Higher is better.
 * Returns null if the element is disqualified (off-screen, too small,
 * dominated by UI chrome, etc.).
 */
function scoreContentBlock(el: Element, hasLayout: boolean): BlockScore | null {
  if (LAYOUT_SKIP_TAGS.has(el.tagName.toLowerCase())) return null;

  const rect = el.getBoundingClientRect();
  // Reject elements that ARE the body / html — they own the whole page chrome.
  if (el === document.body || el === document.documentElement) return null;

  if (hasLayout) {
    // Soft size gate: prefer elements visible in the layout but don't require
    // them. Tests/sparse pages may render content at much smaller sizes.
    if (rect.width > 0 && rect.width < 200) return null;
  }

  const text = (el.textContent ?? '').trim();
  if (text.length < LAYOUT_MIN_TEXT_CHARS) return null;

  // Reject elements dominated by link text — those are link lists / nav menus.
  const linkText = Array.from(el.querySelectorAll('a'))
    .map(a => (a.textContent ?? '').trim())
    .join(' ');
  const linkRatio = linkText.length / Math.max(text.length, 1);
  if (linkRatio > LAYOUT_MAX_LINK_TEXT_RATIO) return null;

  // Reject elements with too many buttons relative to text — UI chrome.
  const buttonCount = el.querySelectorAll('button, [role="button"]').length;
  const buttonDensity = buttonCount / Math.max(text.length / 100, 1);
  if (buttonDensity > LAYOUT_MAX_BUTTON_DENSITY * 100) return null;

  const imgCount = el.querySelectorAll('img').length;
  const paragraphCount = el.querySelectorAll('p, blockquote, li, h1, h2, h3, h4').length;

  // Score: visual area + text density, boosted by paragraphs/images, penalised
  // by link density. Centre-column elements score highest because area dominates.
  const area = rect.width * rect.height;
  const visualScore = Math.sqrt(area);
  const textScore = text.length;
  const structureBonus = paragraphCount * 50 + imgCount * 20;
  const linkPenalty = 1 - linkRatio;

  const score = (visualScore + textScore + structureBonus) * linkPenalty;
  return { el, score, textLen: text.length, width: rect.width, height: rect.height };
}

/**
 * Find the best content block on the page using layout heuristics. Walks every
 * element, scores those that look like content, and returns the highest-scoring.
 * Skips descendants once an ancestor wins — picking the outermost qualifying
 * block avoids tearing children out of their parent's layout.
 */
function findContentBlockByLayout(): Element | null {
  // In headless/jsdom environments getBoundingClientRect returns zeros for
  // every element. Detect this once: when there's no real layout, skip the
  // size gating but require a higher structural bar (multiple child blocks)
  // before accepting a candidate — without rects we can't distinguish the
  // "main column" from a single paragraph in body root.
  const probe = document.body.getBoundingClientRect();
  const hasLayout = probe.width > 0 && probe.height > 0;
  // Pierce open shadow roots — some sites (Stansberry) render the article
  // body inside <template shadowrootmode="open">, which plain querySelectorAll
  // would miss. See querySelectorAllDeep in the Shadow-DOM helpers section.
  const all = querySelectorAllDeep(document.body, '*');
  const scored: BlockScore[] = [];
  for (const el of all) {
    const s = scoreContentBlock(el, hasLayout);
    if (s) scored.push(s);
  }
  if (scored.length === 0) return null;
  // Headless safety: require at least 3 block-level descendants to count.
  // Real layout gating already enforces this implicitly via the 300×200 box.
  if (!hasLayout) {
    const filtered = scored.filter(s =>
      s.el.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4').length >= 3
    );
    if (filtered.length === 0) return null;
    scored.length = 0;
    scored.push(...filtered);
  }

  // Sort by descending score, then pick the best whose chosen ancestor isn't already taken.
  scored.sort((a, b) => b.score - a.score);
  const chosen: Element[] = [];
  for (const s of scored) {
    const containedByChosen = chosen.some(c => c.contains(s.el));
    const containsChosen = chosen.some(c => s.el.contains(c));
    // Prefer the outer block: if this candidate contains one already chosen,
    // remove the inner one and take this outer one.
    if (containsChosen) {
      for (let i = chosen.length - 1; i >= 0; i--) {
        if (s.el.contains(chosen[i])) chosen.splice(i, 1);
      }
      chosen.push(s.el);
    } else if (!containedByChosen) {
      chosen.push(s.el);
    }
  }

  // Return the highest-scoring of the final chosen set.
  if (chosen.length === 0) return null;
  const best = scored.find(s => chosen.includes(s.el))!;
  log(LL.DEBUG, `Discerned: layout-finder picked <${best.el.tagName.toLowerCase()}> textLen=${best.textLen} ${Math.round(best.width)}×${Math.round(best.height)}`, 'url:', window.location.href);
  const host = shadowHostOf(best.el);
  if (host) {
    log(LL.DEBUG, `Discerned: layout finder winner is inside shadow root of <${host.tagName.toLowerCase()}>`, 'url:', window.location.href);
  }
  return best.el;
}

/**
 * When `el` is one of several structurally-similar siblings (a feed or thread
 * card), return its parent so the whole feed is captured. Otherwise return `el`.
 *
 * Signal: count siblings sharing `el`'s tag and class signature. If 2+ match
 * and together they hold significantly more text than `el` alone, the parent
 * is the thread/feed container.
 */
function maybeExpandToFeed(el: Element): Element {
  const parent = el.parentElement;
  if (!parent || parent === document.body) return el;

  const sig = `${el.tagName.toLowerCase()}|${el.className}`;
  const siblings = Array.from(parent.children).filter(c =>
    `${c.tagName.toLowerCase()}|${c.className}` === sig
  );
  if (siblings.length < 2) return el;

  const elText = (el.textContent ?? '').trim().length;
  const parentText = (parent.textContent ?? '').trim().length;
  // Parent must hold ≥ 1.5× the chosen element's text — otherwise the siblings
  // are mostly empty/decorative and expanding adds noise.
  if (parentText < elText * 1.5) return el;

  // Don't expand past a sensible boundary — bail if the parent looks like the
  // page chrome (full viewport width or contains nav/header).
  const parentRect = parent.getBoundingClientRect();
  if (parentRect.width > window.innerWidth * 0.95) return el;
  if (parent.querySelector(':scope > nav, :scope > header, :scope > footer')) return el;

  log(LL.DEBUG, `Discerned: layout-finder expanded to feed parent — ${siblings.length} siblings, ${parentText} chars vs ${elText} alone`, 'url:', window.location.href);
  return parent;
}

/**
 * Derive a clean text summary of the article from its sanitised clone, used
 * for `bodyText` and downstream excerpts (overlay preview, library row, search).
 * Walks prose tags only — paragraphs, headings, list items, blockquotes, table
 * cells, captions — and joins their text with blank lines. Skips chrome wrappers
 * (divs, buttons, custom-element shells) whose text would otherwise lead the
 * extracted body. Falls back to the full `textContent` when no prose tags are
 * present so prose-less pages still get *something*.
 */
const PROSE_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dt, dd, pre, td, th, figcaption';
/**
 * Flatten the capture to plain text for the cast body. When `imageUrls` (the
 * cast's image set) is given, each URL is emitted as its own paragraph at the
 * position of its <img> in document order — so Nostr clients that auto-embed
 * image URLs render the images where they sat in the article, instead of all
 * of them stacking at the top/bottom. First occurrence claims the URL (same
 * dedupe rule as collectCastImageUrls, so text and imeta tags stay in sync).
 */
function proseText(root: Element, imageUrls?: string[]): string {
  const remaining = new Set(imageUrls ?? []);
  const baseUrl = window.location.href;
  const parts: string[] = [];
  let textParts = 0;
  root.querySelectorAll(`${PROSE_SELECTOR}, img`).forEach(el => {
    if (el.tagName.toLowerCase() === 'img') {
      if (remaining.size === 0) return;
      const abs = resolveImgSrc(el as HTMLImageElement, baseUrl);
      if (abs && remaining.delete(abs)) parts.push(abs);
      return;
    }
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > 0) { parts.push(t); textParts++; }
  });
  if (textParts === 0) return (root.textContent ?? '').trim();
  return parts.join('\n\n');
}

async function extractArticle(opts: CaptureOptions): Promise<Capture> {
  const base = baseFields();
  log(LL.DEBUG, `Discerned: extractArticle — smartArticleDetection=${opts.smartArticleDetection} stripInlineStyles=${opts.stripInlineStyles}`, 'url:', base.url);
  logShadowPresence(base.url);

  // Pre-harvest embedded tweets from the LIVE DOM before any clone/markExcluded
  // pass can lose hidden blockquotes (widgets.js leaves the source blockquote
  // behind with display:none, which markExcluded would otherwise drop).
  const harvestedTweets = await harvestEmbeddedTweets(document);

  // Apply per-site live-DOM tagger (if registered for this hostname) so the
  // captured HTML carries dx-* markers across sanitisation regardless of
  // which extraction tier wins below. When a site tagger runs, the generic
  // semantic-structure pass downstream is skipped so it doesn't re-tag the
  // same elements with conflicting markers.
  siteTaggerActive = applySiteTagger();

  // Capture live video frames BEFORE any clone step. Media Chrome and similar
  // custom players never set the <video poster> attribute — the thumbnail is
  // managed inside their shadow DOM. Canvas-capture the current frame from
  // every playing <video> while we still have live media, then pass the map
  // to every substituteVideosWithPosters call below so posterless videos get
  // a real image instead of the ▶ Video fallback link.
  const liveVideoFrames = await captureVideoFrames(document.body);

  // Tier 0: Twitter/X — extract clean tweet card from data-testid selectors.
  if (isTweetHost(window.location.href)) {
    const tweet = await extractTweet(base);
    if (tweet) return tweet;
    log(LL.DEBUG, 'Discerned: Twitter extractor yielded nothing, falling through to generic', 'url:', base.url);
  }

  const thumbnailUrl = getPageThumbnail();
  const inlinedThumbnail = thumbnailUrl ? await inlineImage(thumbnailUrl) : null;

  // Tier 1: semantic article element — preserves images at their correct positions.
  // Skipped when a site tagger pinned an explicit capture root (Tier 1.5 below
  // uses it): the tagger's root is more precise than a page-level <main>/<article>.
  const articleEl = siteTaggerRoot ? null : findArticleElement(opts.smartArticleDetection);
  if (articleEl) {
    log(LL.DEBUG, `Discerned: article captured via semantic element <${articleEl.tagName.toLowerCase()}>`, 'url:', base.url);
    const cleanup = markExcluded(document.body);
    const sizeCleanup = annotateLiveImageSizes(articleEl);
    const clone = deepCloneWithShadow(articleEl);
    sizeCleanup();
    cleanup();
    clone.querySelector('#discerned-overlay')?.remove();
    // Site-tagger post-clone hook — runs BEFORE removeMarked so the hook can
    // lift content out of soon-to-be-excluded wrappers (Reddit subreddit
    // avatar inside the "Go to" anchor, YT player → poster figure).
    if (siteTaggerPostClone) {
      try { siteTaggerPostClone(clone); }
      catch (err) { log(LL.WARN, 'Discerned: site tagger postClone failed:', err); }
    }
    removeMarked(clone);
    stripSizeMarkers(clone);
    stripPageChrome(clone);
    substituteVideosWithPosters(clone, liveVideoFrames);
    substituteStarRatings(clone);
    await substituteEmbeddedTweets(clone, harvestedTweets);
    tagSemanticStructure(clone);
    const imgsBefore = clone.querySelectorAll('img').length;
    sanitiseTreeInPlace(clone as HTMLElement, opts.stripInlineStyles);
    const imgsAfter = clone.querySelectorAll('img[style]').length;
    log(LL.DEBUG, `Discerned: sanitiseTreeInPlace done — ${imgsBefore} imgs, ${imgsAfter} with remaining inline style, stripInlineStyles=${opts.stripInlineStyles}`, 'url:', base.url);
    log(LL.TRACE, `Discerned: sanitised bodyHtml (first 2000 chars): ${clone.innerHTML.slice(0, 2000)}`, 'url:', base.url);
    const { html: inlined, imageUrls } = await inlineAllImages(clone.innerHTML.trim());
    log(LL.DEBUG, `Discerned: article imgs after inlining — ${(inlined.match(/<img[^>]*>/gi) ?? []).length} total`, 'url:', base.url);
    return {
      ...base,
      format: 'article',
      bodyHtml: inlined,
      bodyText: proseText(clone, imageUrls),
      thumbnail: inlinedThumbnail,
      thumbnailUrl,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    };
  }

  // Tier 1.5: layout-based content-block finder. For SPAs (Nostr clients,
  // Mastodon, Bluesky, Threads, Reddit's new UI) that render as div-soup with
  // hashed class names — no semantic markup, Readability gives up. Pick the
  // largest centre-column block with real prose by visual layout.
  // A site tagger may have already pinpointed the content root; prefer it so we
  // don't capture page chrome (sidebars, search, banners) the finder would grab.
  const layoutEl = siteTaggerRoot ?? findContentBlockByLayout();
  if (layoutEl) {
    log(LL.DEBUG, `Discerned: article captured via layout finder <${layoutEl.tagName.toLowerCase()}>`, 'url:', base.url);
    const cleanup = markExcluded(document.body);
    const sizeCleanup = annotateLiveImageSizes(layoutEl);
    // A tagger-supplied root is already the intended scope — don't widen it.
    const expanded = siteTaggerRoot ? layoutEl : maybeExpandToFeed(layoutEl);
    // When a site tagger has scoped the capture root, clear EXCL markers on
    // elements inside it: the tagger authoritatively said this is content,
    // so a sticky-positioned cover/sidebar inside that root is content too
    // (e.g. Goodreads's <div class="Sticky"> wrapping the book cover).
    if (siteTaggerRoot) {
      siteTaggerRoot.querySelectorAll(`[${EXCL_MARKER}]`).forEach(el => el.removeAttribute(EXCL_MARKER));
      // After unmasking, re-promote the tagger's own excludes — elements
      // stamped with `dx-excl` are interactive widgets we know don't belong
      // in the captured clip (Goodreads's "Want to Read" / "Rate this book"
      // BookActions row, mobile-mirror actions, follow buttons, etc.).
      siteTaggerRoot.querySelectorAll('.dx-excl').forEach(el => el.setAttribute(EXCL_MARKER, '1'));
    }
    const clone = deepCloneWithShadow(expanded);
    sizeCleanup();
    cleanup();
    clone.querySelector('#discerned-overlay')?.remove();
    // Site-tagger post-clone hook: runs only on the detached clone so any
    // destructive mutations (replaceWith, restructuring) never leak into
    // the live page. Used by YouTube (player → poster) and Reddit
    // (avatar hoist + 2-row byline column rebuild).
    //
    // Runs BEFORE removeMarked so the hook can lift content (e.g. Reddit's
    // subreddit avatar) out of an EXCL_MARKER'd wrapper before that
    // wrapper is dropped.
    if (siteTaggerPostClone) {
      try { siteTaggerPostClone(clone); }
      catch (err) { log(LL.WARN, 'Discerned: site tagger postClone failed:', err); }
    }
    removeMarked(clone);
    stripSizeMarkers(clone);
    // Skip chrome-strip when a site tagger authoritatively scoped this root —
    // the tagger may have intentionally retained landmark elements.
    if (!siteTaggerRoot) stripPageChrome(clone);
    substituteVideosWithPosters(clone, liveVideoFrames);
    substituteStarRatings(clone);
    await substituteEmbeddedTweets(clone, harvestedTweets);
    tagSemanticStructure(clone);
    sanitiseTreeInPlace(clone as HTMLElement, opts.stripInlineStyles);
    const { html: inlined, imageUrls } = await inlineAllImages(clone.innerHTML.trim());
    log(LL.DEBUG, `Discerned: layout-finder imgs after inlining — ${(inlined.match(/<img[^>]*>/gi) ?? []).length} total`, 'url:', base.url);
    return {
      ...base,
      format: 'article',
      bodyHtml: inlined,
      bodyText: proseText(clone, imageUrls),
      thumbnail: inlinedThumbnail,
      thumbnailUrl,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    };
  }

  // Tier 2: Readability — for pages without semantic article markup.
  const parsed = parseReadability();
  if (parsed) {
    log(LL.DEBUG, 'Discerned: article captured via Readability', 'url:', base.url);
    let sanitized = sanitizeHtmlString(parsed.content);
    if (!/<img[\s>]/i.test(sanitized) && thumbnailUrl && isSafeImageSrc(thumbnailUrl)) {
      const alt = (parsed.title || base.title).replace(/"/g, '&quot;');
      sanitized = `<figure><img src="${thumbnailUrl}" alt="${alt}"></figure>\n${sanitized}`;
    }
    const { html: inlined, imageUrls } = await inlineAllImages(sanitized);
    log(LL.DEBUG, `Discerned: article imgs after inlining — ${(inlined.match(/<img[^>]*>/gi) ?? []).length} total`, 'url:', base.url);
    // Readability hands back a string, not a tree — when cast images exist,
    // re-parse the (pre-inlining) sanitized HTML so proseText can interleave
    // the image URLs at their in-article positions. With no images the body
    // stays Readability's own textContent, exactly as before.
    let bodyText = parsed.textContent.trim();
    if (imageUrls.length > 0) {
      const bodyDoc = new DOMParser().parseFromString(`<div>${sanitized}</div>`, 'text/html');
      const bodyRoot = bodyDoc.body.firstElementChild;
      if (bodyRoot) bodyText = proseText(bodyRoot, imageUrls);
    }
    return {
      ...base,
      format: 'article',
      title: parsed.title || base.title,
      bodyHtml: inlined,
      bodyText,
      thumbnail: inlinedThumbnail,
      thumbnailUrl,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    };
  }

  // Tier 3: full body — last resort.
  log(LL.WARN, 'Discerned: article falling back to full body', 'url:', base.url);
  const bodyClone = cloneBodyClean();
  stripSizeMarkers(bodyClone);
  stripPageChrome(bodyClone);
  substituteVideosWithPosters(bodyClone, liveVideoFrames);
  substituteStarRatings(bodyClone);
  await substituteEmbeddedTweets(bodyClone, harvestedTweets);
  tagSemanticStructure(bodyClone);
  sanitiseTreeInPlace(bodyClone);
  const { html: inlined, imageUrls } = await inlineAllImages(bodyClone.innerHTML.trim());
  return {
    ...base,
    format: 'article',
    bodyHtml: inlined,
    bodyText: proseText(bodyClone, imageUrls),
    thumbnail: inlinedThumbnail,
    thumbnailUrl,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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
    // Annotate live <img>s with their rendered size before cloning so Readability's
    // output preserves source-page proportions. Without this, sanitisation strips
    // class-based sizing and images fall back to intrinsic resolution — making
    // avatars on SPA feed pages (primal, mastodon, etc.) huge.
    const sizeCleanup = annotateLiveImageSizes(document.body);
    const bodyClone = deepCloneWithShadow(document.body) as HTMLElement;
    sizeCleanup();
    stripSizeMarkers(bodyClone);
    bodyClone.querySelector('#discerned-overlay')?.remove();
    // Remove nodes whose text is dominated by known anti-adblock phrases — these
    // score well with Readability (clean short prose) but are not article content.
    const ADBLOCK_SIGNAL = 'ad or script blocking software';
    bodyClone.querySelectorAll<HTMLElement>('*').forEach(el => {
      if ((el.textContent ?? '').includes(ADBLOCK_SIGNAL)) el.remove();
    });
    clone.body.replaceWith(bodyClone);
    // Readability resolves relative URLs against the document location; provide
    // a <base> so links/images in the cloned body resolve correctly.
    const base = clone.createElement('base');
    base.href = document.location.href;
    clone.head.appendChild(base);
    const result = new Readability(clone).parse();
    log(LL.DEBUG, 'Discerned: Readability result title:', result?.title, 'url:', window.location.href);
    return result;
  } catch (err) {
    log(LL.WARN, 'Discerned: Readability failed', err, 'url:', window.location.href);
    return null;
  }
}

// ── Full page ────────────────────────────────────────────────────────────────

async function extractFullPage(opts: CaptureOptions): Promise<Capture> {
  // On twitter.com / x.com the user almost certainly wants the tweet card,
  // not the full SPA shell. Route through the same Tier 0 extractor as
  // article-format and preserve format='full-page' on the returned Capture.
  if (isTweetHost(window.location.href)) {
    const tweet = await extractTweet(baseFields(), 'full-page');
    if (tweet) return tweet;
    log(LL.DEBUG, 'Discerned: full-page Twitter extractor yielded nothing, falling through to generic', 'url:', window.location.href);
  }

  // Apply per-site live-DOM tagger so dx-* markers + dx-excl flags land on
  // live nodes before clone. The cloned body inherits them via cloneNode.
  siteTaggerActive = applySiteTagger();

  // Pre-harvest embedded tweets from the LIVE DOM before cloning (the iframe
  // round-trip + hidden-blockquote data only exists pre-clone).
  const harvestedTweets = await harvestEmbeddedTweets(document);
  const fpLiveVideoFrames = await captureVideoFrames(document.body);
  // Clone the body only — using outerHTML (which includes <html>/<head>) causes
  // DOMParser to restructure the document in ways that leave <script> content as
  // orphaned text nodes that querySelectorAll('script') can't reach.
  const bodyClone = cloneBodyClean();
  // Site tagger post-clone work (dx-excl promotion + postClone hook + removeMarked).
  // Shared with extractArticle + extractSelection so all three formats produce
  // the same site-tagger-aware structure.
  applyTaggerToClone(bodyClone);
  stripPageChrome(bodyClone);
  substituteVideosWithPosters(bodyClone, fpLiveVideoFrames);
  substituteStarRatings(bodyClone);
  await substituteEmbeddedTweets(bodyClone, harvestedTweets);
  // Generic semantic tagging (skipped automatically when a site tagger was
  // active). Stamps dx-byline / dx-stats / dx-header on news + blog markup
  // so the captured HTML carries layout hints across sanitisation.
  tagSemanticStructure(bodyClone);
  sanitiseTreeInPlace(bodyClone, opts.stripInlineStyles);
  const { html: inlined, imageUrls } = await inlineAllImages(bodyClone.innerHTML.trim());
  return {
    ...baseFields(),
    format: 'full-page',
    bodyHtml: inlined,
    bodyText: bodyClone.textContent?.trim() ?? '',
    thumbnail: getPageThumbnail(),
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
  };
}

const EXCL_MARKER = 'data-discerned-excl';

/**
 * Mark elements in the live DOM that should be excluded from any clone, then
 * return a cleanup that removes those markers from the live DOM.
 * Must be called while elements are still attached — getComputedStyle requires
 * an attached node. The markers survive cloneNode/cloneContents, so the clone
 * can be cleaned up with removeMarked() afterward.
 */
function markExcluded(root: HTMLElement = document.body): () => void {
  forEachDeepElement(root, el => {
    if (el.id === 'discerned-overlay') return;
    const s = window.getComputedStyle(el);
    if (s.position === 'fixed' || s.position === 'sticky' ||
        s.display === 'none' || s.visibility === 'hidden') {
      el.setAttribute(EXCL_MARKER, '1');
      return;
    }
    // Screen-reader-only elements (the classic 1px clip pattern). Visually
    // absent on the source page but their text glues onto visible siblings
    // after sanitisation — Stack Overflow's badge counts read "22" visibly
    // plus a hidden "22 gold badges" duplicate, rendering as "2222 gold
    // badges" in the clip.
    if (s.position === 'absolute' &&
        ((parseFloat(s.width) <= 1 && parseFloat(s.height) <= 1) ||
         s.clip.startsWith('rect(0px') ||
         s.clipPath.startsWith('inset('))) {
      el.setAttribute(EXCL_MARKER, '1');
    }
  });
  return () => querySelectorAllDeep(root, `[${EXCL_MARKER}]`).forEach(el => el.removeAttribute(EXCL_MARKER));
}

/** Remove all marked elements from a detached clone or fragment. */
function removeMarked(root: Element | DocumentFragment): void {
  (root as Element).querySelectorAll(`[${EXCL_MARKER}]`).forEach(el => el.remove());
}

/**
 * Strip EXCL_MARKER from elements that are partial-ancestor wrappers around
 * selected content. cloneContents() on a Range copies attributes of partially
 * cloned ancestors, so a sticky/fixed/hidden wrapper several levels above the
 * user's selection rides into the fragment with the marker — and removeMarked
 * would then delete it, taking the selection with it. The user selected
 * INSIDE these wrappers, so they aren't chrome to discard; only leaf elements
 * that were fully inside the selection range and happen to be chrome should
 * remain marked. Heuristic: an element with non-trivial text or media content
 * is a wrapper carrying real content, so drop the marker on it.
 */
function unmarkWrappers(root: Element | DocumentFragment): void {
  (root as Element).querySelectorAll(`[${EXCL_MARKER}]`).forEach(el => {
    const text = (el.textContent ?? '').trim();
    const hasMedia = !!el.querySelector('img, picture, video, svg');
    if (text.length > 0 || hasMedia) el.removeAttribute(EXCL_MARKER);
  });
}

/**
 * Deep-clone document.body with the Discerned overlay, fixed/sticky chrome,
 * and hidden elements removed. Annotates every <img> with its rendered size
 * before cloning so the captured HTML preserves source-page proportions even
 * after sanitisation strips wrapper classes.
 */
function cloneBodyClean(): HTMLElement {
  const cleanup = markExcluded(document.body);
  const sizeCleanup = annotateLiveImageSizes(document.body);
  const clone = deepCloneWithShadow(document.body) as HTMLElement;
  sizeCleanup();
  cleanup();

  clone.querySelector('#discerned-overlay')?.remove();
  removeMarked(clone);

  return clone;
}

// ── Per-site live-DOM taggers ────────────────────────────────────────────────
//
// Each tagger runs once on the *live* page DOM (before we clone for capture),
// using site-specific structural selectors to stamp `dx-*` class markers
// (dx-post, dx-reply, dx-quote, dx-header) that survive sanitisation. The
// generic semantic tagger then runs as a fallback for sites without a tagger.
//
// To add a site: write a tagger function that walks the live DOM with
// structural selectors stable for that site (data-* attributes, class-name
// prefixes), stamps the relevant dx-* markers, and register it in SITE_TAGGERS
// by hostname. Keep the tagger small — five-to-ten querySelectorAll calls.
// Layout is left to CSS via the dx-* selectors.
//
// The clip pipeline then runs the regular layout-finder/Readability, but the
// captured HTML carries our markers across sanitisation and the web app's
// .clip-body CSS produces a clean visual.

/**
 * Tag primal.net note threads. Stable anchors:
 *   - `[class*="_primaryNote_"]`  the main note container
 *   - `[class*="_noteThread_"]`   each reply in the replies holder
 *   - `[class*="_mentionedNote_"]` or `[class*="embeddedNote"]` quoted note
 *   - `[class*="_header_"]` or `[class*="_headerInfo_"]`  avatar+name row
 *
 * Primal renders embedded notes as multiple sibling <a> elements (header,
 * body, mentions, image — each its own <a> pointing at the same nevent).
 * We mark them all `dx-quote-frag` and let CSS draw a single bordered
 * card around them via grouping styles (see globals.css).
 */
function tagPrimal(root: Document | Element): void {
  // Primary note
  root.querySelectorAll('[class*="_primaryNote_"]').forEach(el => appendClass(el, 'dx-post'));
  // Replies
  root.querySelectorAll('[class*="_noteThread_"]').forEach(el => appendClass(el, 'dx-reply'));
  // Embedded notes — these are <a> elements wrapping fragments. We tag the
  // ANCESTOR DIV (the embedded-note row container) so CSS can draw one card
  // around all the <a> siblings inside it. The wrapper is the closest div
  // that has both a header <a> and a body <a> as descendants.
  const embeddedAnchors = Array.from(
    root.querySelectorAll('a[class*="_mentionedNote_"], a[class*="embeddedNote"]'),
  );
  const wrappers = new Set<Element>();
  for (const a of embeddedAnchors) {
    // Walk up at most 5 levels to find a wrapper div that contains multiple
    // sibling <a> elements all pointing to the same href. That wrapper is
    // the visual card.
    let cur: Element | null = a.parentElement;
    let depth = 0;
    while (cur && depth < 5) {
      const sameHrefSiblings = Array.from(cur.children).filter(
        c => c.tagName === 'A' && c.getAttribute('href') === a.getAttribute('href'),
      );
      if (sameHrefSiblings.length >= 1 && cur.children.length <= 6) {
        wrappers.add(cur);
        break;
      }
      cur = cur.parentElement;
      depth++;
    }
    // Tag the <a> with the FRAG marker so CSS strips its underline/border
    // (it's already inside a dx-quote wrapper that provides the frame).
    appendClass(a, 'dx-quote-frag');
    // Remove any pre-existing dx-quote on the <a> from earlier passes — the
    // wrapper is the bordered card, fragments must not draw their own border.
    a.classList.remove('dx-quote');
  }
  for (const w of wrappers) appendClass(w, 'dx-quote');
  // Headers — three patterns in primal:
  //   1. Primary notes: _headerInfo_ wraps avatar+name.
  //   2. Quoted/embedded notes: _mentionedNoteHeader_ wraps avatar+name.
  //   3. Reply notes use _content_ as wrapper of _leftSide_ + _rightSide_.
  root.querySelectorAll('[class*="_headerInfo_"], [class*="_mentionedNoteHeader_"]').forEach(el => {
    if (el.querySelector('img')) appendClass(el, 'dx-header');
  });
  // Reply notes: tag the _content_ wrapper inside _noteThread_ as dx-reply-row.
  // The wrapper has _leftSide_ (avatar) + _rightSide_ (name + body) as its
  // two direct children — exactly the avatar+name flex pattern.
  root.querySelectorAll('[class*="_noteThread_"] > [class*="_content_"]').forEach(el => {
    if (el.querySelector('[class*="_leftSide_"]') && el.querySelector('[class*="_rightSide_"]')) {
      appendClass(el, 'dx-reply-row');
    }
  });
  // Author info row (name + verification + time). Stamped on the small
  // wrapper that contains the username, a verification icon, and a timestamp
  // — these should sit inline on one line with spaces between them. Primal
  // uses _authorInfo_ in replies and _userInfo_ + _time_ in quote headers.
  root.querySelectorAll('[class*="_authorInfo_"], [class*="_postInfo_"]').forEach(el => {
    appendClass(el, 'dx-author');
  });
  // Top-zaps row (avatar + sats). _zapHighlights_ = primary note row;
  // _zapHighlightsCompact_ = inline variant inside replies; _topZaps_ = outer
  // wrapper. Tag all three so the row lays out horizontally.
  root.querySelectorAll('[class*="_zapHighlights"], [class*="_topZaps_"]').forEach(el => appendClass(el, 'dx-zaps-row'));
  // Footers / stats rows (reply/like/repost). Tag only the inner footer that
  // actually contains buttons — primal nests two _footer_ divs, the outer is
  // just a wrapper.
  root.querySelectorAll('[class*="_footer_"]').forEach(el => {
    if (el.querySelector('button')) appendClass(el, 'dx-stats');
  });
}

// A site tagger stamps dx-* markers on the live DOM and may optionally return
// a narrowed capture root (e.g. the posts column, excluding page chrome). When
// it returns an element, extractArticle captures that subtree instead of asking
// the generic layout finder — the tagger has authoritative knowledge of where
// the content lives. Returning nothing leaves root selection to the pipeline.
/**
 * Tag bsky.app posts. Bluesky is a React SPA with hashed class names but stable
 * `data-testid` attributes:
 *   - `feedItem-by-<handle>`        each post row on a profile/feed page
 *   - `postThreadItem-by-<handle>`  each post on a thread (main post + replies)
 *   - `userAvatarImage`             the avatar
 *   - `replyBtn` / `likeBtn`        buttons in the action/stats row
 *
 * Each post lays out as: [avatar | name+handle+date] then body, then a stats
 * row. Two header variants exist: replies/feed items carry a `/post/` date
 * anchor in the header; the thread's *main* post does not (the date is plain
 * text and a Follow button sits where the date would be). So we anchor the
 * header on the avatar <a> + the author-name <a> (a /profile/ link that isn't
 * the avatar), which is present in both variants.
 *
 * Returns the content column as the narrowed capture root — `profileScreen` on
 * a profile page, `postThreadScreen` on a thread — so the clip excludes page
 * chrome (global search box, sign-in bar, trending sidebar) that the generic
 * <main>/layout finders would otherwise pull in.
 */
function tagBsky(root: Document | Element): Element | void {
  const posts = Array.from(
    root.querySelectorAll('[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]'),
  );
  for (const post of posts) {
    appendClass(post, 'dx-post');

    const avatarImg = post.querySelector('[data-testid="userAvatarImage"] img, [data-testid="userAvatarImage"]');
    const avatarAnchor = post.querySelector('[data-testid="userAvatarImage"]')?.closest('a') ?? null;
    // Mark the avatar image directly so its round-pin CSS doesn't leak onto body
    // photos that happen to fall inside the (sometimes broad) header wrapper.
    if (avatarImg) {
      const img = avatarImg.tagName === 'IMG' ? avatarImg : avatarImg.querySelector('img');
      if (img) appendClass(img, 'dx-avatar');
    }
    // The author-name anchor: a /profile/ link that is NOT the avatar anchor and
    // carries visible text (the display name). Present in both header variants.
    let nameAnchor: Element | null = null;
    for (const a of Array.from(post.querySelectorAll('a[href*="/profile/"]'))) {
      if (a === avatarAnchor || avatarAnchor?.contains(a)) continue;
      if ((a.textContent ?? '').trim().length > 0) { nameAnchor = a; break; }
    }
    if (avatarAnchor && nameAnchor) {
      const headerRow = commonWrapper(avatarAnchor, nameAnchor, post);
      if (headerRow) appendClass(headerRow, 'dx-header');
    }

    // Stats row: the wrapper holding the reply/repost/like/share buttons.
    const replyBtn = post.querySelector('[data-testid="replyBtn"]');
    const likeBtn = post.querySelector('[data-testid="likeBtn"]');
    if (replyBtn && likeBtn) {
      const statsRow = commonWrapper(replyBtn, likeBtn, post);
      if (statsRow) appendClass(statsRow, 'dx-stats');
    }
  }

  // Feed chrome bsky renders inline with the posts:
  //
  // (a) The "Suggested for you" follow-suggestions module on profile pages —
  //     unrelated accounts, not content. Located by its heading text, then
  //     climbed to the module wrapper (the ancestor that also contains the
  //     suggestion cards' avatars).
  for (const el of Array.from(root.querySelectorAll('div, span'))) {
    if ((el.textContent ?? '').trim() !== 'Suggested for you') continue;
    if (el.querySelector('div, span')) continue; // want the deepest text node holder
    let box: Element | null = null;
    let cursor: Element = el;
    for (let i = 0; i < 6 && cursor.parentElement; i++) {
      cursor = cursor.parentElement;
      if (cursor.querySelectorAll('[data-testid="userAvatarImage"]').length >= 2) {
        box = cursor;
        break;
      }
    }
    if (box && !box.querySelector('[data-testid^="feedItem-by-"]')) {
      appendClass(box, 'dx-excl');
    }
    break;
  }

  // (b) "Reposted by …" gutter labels — bsky renders these as a leaf <div>
  //     whose grid cell collapses to a crushed one-word-per-line strip after
  //     sanitisation. They sit at feed level (siblings of the feedItem posts),
  //     so scan the whole root, not per-post. The visual target (see CLAUDE.md
  //     optimized-sites table) has no repost attribution, so drop each label.
  for (const el of Array.from(root.querySelectorAll('div, span'))) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!/^Reposted by\b/.test(t) || t.length > 80) continue;
    // Deepest match only (the leaf text holder), so we don't excl a whole post.
    if (el.querySelector('div, span, a')) continue;
    appendClass(el, 'dx-excl');
  }

  // Narrow the capture to the content column. profileScreen on a profile page,
  // postThreadScreen on a thread page; neither present → leave root to the pipeline.
  const column =
    root.querySelector('[data-testid="profileScreen"]') ??
    root.querySelector('[data-testid="postThreadScreen"]');
  return column ?? undefined;
}

/**
 * Lowest common ancestor of `a` and `b` that is still a descendant of `bound`.
 * Returns null if they share no ancestor under `bound`.
 */
function commonWrapper(a: Element, b: Element, bound: Element): Element | null {
  const ancestors = new Set<Element>();
  for (let cur: Element | null = a; cur && cur !== bound.parentElement; cur = cur.parentElement) {
    ancestors.add(cur);
  }
  for (let cur: Element | null = b; cur && cur !== bound.parentElement; cur = cur.parentElement) {
    if (ancestors.has(cur)) return cur;
  }
  return null;
}

/**
 * Tag goodreads.com book pages. Stable anchors (className prefixes survive
 * Next.js builds because Goodreads uses BEM-style names like
 * `BookPageTitleSection__title`, not hashed CSS-modules):
 *   - `main.BookPage`                              the page root
 *   - `.BookPage__leftColumn` / `.BookPage__rightColumn`  the two columns
 *   - `.BookPage__bookCover .BookCard`             the cover image card
 *   - `.BookPageTitleSection`                      series h3 + title h1
 *   - `.BookPageMetadataSection__contributor`      author byline
 *   - `.BookPageMetadataSection__ratingStats`      stars + 3.85 + counts
 *   - `[data-testid="genresList"]`                 the genres pill list
 *   - `.AuthorPreview`                             the "About the author" card
 *
 * Stamps `dx-book-hero` on a synthesized row holding cover + title block, so
 * CSS can lay them out side-by-side (Goodreads achieves this via two separate
 * columns whose layout doesn't survive sanitisation). Stamps `dx-genres` so
 * the genre pills get inline-block spacing back. Stamps `dx-author-card` on
 * the AuthorPreview so the avatar + name lay out as a flex row.
 *
 * Returns `main.BookPage` (or the gridContainer) as the narrowed capture root
 * so the clip excludes Goodreads's site header, footer, ads, and the long
 * reviews list (which the generic layout finder otherwise sucks in — captured
 * div was 75k chars).
 */
function tagGoodreads(root: Document | Element): Element | void {
  // /review/list/ is the legacy My Books server-rendered table — completely
  // different layout from the Next.js BookPage. Delegate to a separate path.
  if (/\/review\/list\//i.test(window.location.pathname)) {
    return tagGoodreadsList(root);
  }

  // Exclude interactive widgets that have no value in a static clip — the
  // "Want to Read" dropdown, "Rate this book" star picker, "Shop this series"
  // affiliate link, the share / mobile-actions duplicates, follow buttons,
  // and the right-column mobile-cover mirror. The capture loop honours dx-excl
  // as an EXCL marker after applying its own sticky/fixed unmask.
  root.querySelectorAll(
    '.BookActions, .BookRatingStars, .BookPage__share, ' +
    '.BookPageMetadataSection__mobileBookActions, .AuthorFollowButton, ' +
    '.BookPageTitleSection__share, .BookPage__rightCover',
  ).forEach(el => appendClass(el, 'dx-excl'));

  // Mark cover image: the left-column book-cover holds the primary cover.
  // (The right-column variant is a mobile-mirror that may not render visibly.)
  const leftCoverImg = root.querySelector(
    '.BookPage__leftColumn .BookPage__bookCover img, .BookPage__leftColumn .BookCard img',
  );
  if (leftCoverImg) appendClass(leftCoverImg, 'dx-book-cover');

  // The title section sits in the right column. Stamp it so CSS can pair it
  // with the cover via a parent flex container (.dx-book-hero) — see below.
  const titleSection = root.querySelector('.BookPageTitleSection');
  if (titleSection) appendClass(titleSection, 'dx-book-title');

  // Stamp the contributor (author byline) row so the comma and links lay out
  // inline rather than stacking from default block flow.
  root.querySelectorAll('.BookPageMetadataSection__contributor').forEach(el => {
    appendClass(el, 'dx-author');
  });

  // Stamp the rating stats row — stars on the left, 3.85 in the middle,
  // ratings/reviews counts on the right. Inline-flex layout.
  root.querySelectorAll('.BookPageMetadataSection__ratingStats, .RatingStatistics').forEach(el => {
    appendClass(el, 'dx-stats');
  });

  // Genres list: stamp the <ul> so its <span> children get inline-block
  // spacing back (otherwise "GenresScience FictionFiction..." with no gaps).
  const genresList = root.querySelector(
    '[data-testid="genresList"] ul, .BookPageMetadataSection__genres ul',
  );
  if (genresList) appendClass(genresList, 'dx-genres');

  // AuthorPreview: avatar + (name + follower count) — flex row. The profile
  // div is the two-column wrapper (avatar | container); stamp dx-author-card
  // there so its direct children are exactly what CSS needs to flex.
  root.querySelectorAll('.AuthorPreview .FeaturedPerson__profile').forEach(el => {
    appendClass(el, 'dx-author-card');
  });

  // Narrow the capture to a hero block that contains the cover column, the
  // title block, metadata, genres, and the author preview — but drops site
  // chrome and the long reviews list. We return main.BookPage rather than
  // the gridContainer so that the gridContainer is a CHILD of the captured
  // root (it survives the layout-finder's innerHTML extraction, where the
  // outermost element is discarded). dx-book-grid on the gridContainer
  // gives CSS the flex anchor for cover-beside-title layout.
  const grid = root.querySelector('.BookPage__gridContainer');
  if (grid) appendClass(grid, 'dx-book-grid');
  // Tag the left column (cover) and right column (content) so CSS can give
  // them widths inside the dx-book-grid flex row.
  const leftCol = root.querySelector('.BookPage__leftColumn');
  if (leftCol) appendClass(leftCol, 'dx-book-cover-col');
  const rightCol = root.querySelector('.BookPage__rightColumn');
  if (rightCol) appendClass(rightCol, 'dx-book-content-col');
  return root.querySelector('main.BookPage') ?? grid ?? undefined;
}

/**
 * Tag the legacy /review/list/ "My Books" page. This is server-rendered Rails
 * markup with a long-stable shape (the page predates Goodreads's Next.js
 * rewrite). Anchors:
 *   - `#columnContainer.myBooksPage`   the two-column body
 *   - `#leftCol.reviewListLeft`        left navigation (excluded)
 *   - `#rightCol`                      books table column
 *   - `table#books`                    the books table
 *   - `tr.bookalike.review`            each book row
 *   - `td.field.cover img`             cover thumbnail (URL has _SY75_/_SX50_)
 *
 * Strategy: drop the left nav, all interactive admin widgets (batch edit,
 * shelf settings, review form, ad slots), and hidden table columns. Rewrite
 * cover thumbnail URLs to a larger size so they render readably. Return the
 * `mainContent` block so we keep the page header (`<h1>My Books</h1>`).
 */
function tagGoodreadsList(root: Document | Element): Element | void {
  // Drop the left navigation column entirely + interactive/admin widgets +
  // ad slots + the per-page/sort/pagination footer + pre-hidden table columns.
  root.querySelectorAll(
    '#leftCol, #premiumAdTop, #shelfSettings, #batchEdit, #reviewForm, ' +
    '#shelfChooser0, #controls, #pagestuff, #reorderConfirm, ' +
    '.googleBannerAd, .responsiveSiteFooter, ' +
    // Hidden table columns are duplicated in the DOM with inline display:none;
    // the sanitiser strips inline styles so they'd otherwise become visible.
    'th[style*="display: none"], td[style*="display: none"], ' +
    // The cover cell contains a hover tooltip (book-tooltip / wtrButtonContainer)
    // that's display:none on the live page but leaks visible after sanitisation
    // — it pushes other columns into narrow strips. Drop them.
    '.book-tooltip, .js-tooltip, .wtrButtonContainer, .ratingThanks, ' +
    '.wtrPrompt, .wrongBookKindlePreviewScreen, .kindleCloudReader, ' +
    '.addBookTipPreview, ' +
    // Per-row edit/view/remove links column — interactive admin, not content.
    'td.actions, th.actions, td.field.actions, th.field.actions, ' +
    // Per-row "[edit]" inline links that punctuate cells (shelves, dates, etc).
    'a.shelfChooserLink, a.floatingBoxLink, a.editLink, .actionsWrapper, ' +
    // Phone-link icons that some sandboxed extensions inject into ISBN cells.
    'a.gv-tel-link',
  ).forEach(el => appendClass(el, 'dx-excl'));

  // The cover cell wraps the tooltip inside a `.tooltipTrigger` div with
  // `js-tooltipTrigger`; we want the <img> but not the trigger's tooltip
  // child. The selector above kills the tooltip section; this is just a
  // safety net for the wrapper class.
  root.querySelectorAll('.tooltipTrigger > section').forEach(el => appendClass(el, 'dx-excl'));

  // Goodreads emits a `<label>` inside every `<td>` ("avg rating", "my
  // rating", "shelves", "review", "date read", "date added", ...) as a
  // mobile-stacked screen-reader anchor. CSS hides them on desktop; the
  // sanitiser strips that CSS, leaving the labels visible in every row.
  // Excluding `<label>` globally would break form-rendering elsewhere, so
  // restrict to labels inside a `tr.bookalike` table row.
  root.querySelectorAll('tr.bookalike td > label').forEach(el => appendClass(el, 'dx-excl'));

  // Mark the table + each row so CSS can re-apply table-like layout after
  // sanitisation (which preserves <table>/<tr>/<td> but strips Goodreads's CSS).
  const table = root.querySelector('table#books');
  if (table) appendClass(table, 'dx-book-table');
  root.querySelectorAll('tr.bookalike').forEach(el => appendClass(el, 'dx-book-row'));

  // Rewrite cover thumbnail URLs to a larger size variant. Goodreads's CDN
  // serves predictable size-suffixed JPEGs: `..._SY75_.jpg` = 75px tall,
  // `..._SX50_.jpg` = 50px wide. Bump to ~120-150px for a readable list view.
  root.querySelectorAll('td.cover img, td.field.cover img').forEach(img => {
    const src = img.getAttribute('src');
    if (!src) return;
    const bigger = src.replace(/_S[XY](\d+)_/i, '_SY150_');
    if (bigger !== src) img.setAttribute('src', bigger);
  });

  // Mark cover image + title cell so CSS can size them.
  root.querySelectorAll('td.cover img, td.field.cover img').forEach(img => {
    appendClass(img, 'dx-book-cover');
  });

  // Stamp dx-col-* on each visible column header AND cell so CSS column-width
  // rules survive sanitisation (which strips Goodreads's `field cover` /
  // `field title` class names — only `dx-*` and `tweet-*` survive).
  const colMap: Record<string, string> = {
    cover: 'dx-col-cover',
    title: 'dx-col-title',
    author: 'dx-col-author',
    avg_rating: 'dx-col-avg-rating',
    rating: 'dx-col-rating',
    shelves: 'dx-col-shelves',
    review: 'dx-col-review',
    date_read: 'dx-col-date-read',
    date_added: 'dx-col-date-added',
  };
  for (const [field, marker] of Object.entries(colMap)) {
    root.querySelectorAll(`th.field.${field}, td.field.${field}`).forEach(el => {
      appendClass(el, marker);
    });
  }

  // Return the main content area. `.mainContent` wraps both the header
  // (#leadercol with <h1>My Books</h1>) and the body (#columnContainer);
  // returning it keeps the page title visible. The .mainContent class is
  // discarded (it's the outermost element of innerHTML extraction), so we
  // also stamp dx-book-list on it for any future targeting via a CHILD
  // selector — but the columnContainer below it will carry the layout.
  const columnContainer = root.querySelector('#columnContainer');
  if (columnContainer) appendClass(columnContainer, 'dx-book-list');
  return root.querySelector('.mainContent') ?? columnContainer ?? undefined;
}

/**
 * Tag reddit.com comment threads. New Reddit's SPA uses lit-html custom elements
 * (`shreddit-post`, `shreddit-comment`, `shreddit-comment-tree`) with slotted
 * light-DOM children carrying stable `slot="..."` names. The slots survive
 * regardless of the heavily-hashed inner classes.
 *
 * Stamps:
 *   - `dx-post` on `shreddit-post` and each `shreddit-comment` (visual separation)
 *   - `dx-header` on `[slot="credit-bar"]` (post) and `[slot="commentMeta"]` (comments)
 *   - `dx-stats` on `[slot="post-footer"]` (post) and `[slot="actionRow"]` (comments)
 *   - `dx-avatar` on the avatar img inside `[slot="commentAvatar"]`
 *   - `dx-excl` on chrome links/widgets that survive sanitisation as noise:
 *     "Back" link, "Share" buttons, "Open comment sort options", "Search Comments"
 *
 * Returns `main#main-content` as the narrowed capture root, dropping Reddit's
 * left signup rail and right "Related posts" rail.
 */
function tagReddit(root: Document | Element): Element | void {
  // The post itself. The credit-bar holds a horizontal strip (back arrow,
  // "Go to <subreddit>" link, subreddit avatar, subreddit name, age, author,
  // lock/sticky badges). Drop the back arrow + "Go to" link + badges first
  // so dx-byline gives us a tight "r/sub · 4h ago · author" row.
  const post = root.querySelector('shreddit-post');
  if (post) {
    appendClass(post, 'dx-post');
    const credit = post.querySelector('[slot="credit-bar"]');
    if (credit) {
      appendClass(credit, 'dx-byline');
      // Tag the "Go to mildlyinfuriating" chrome anchor for exclusion. The
      // subreddit avatar img inside it gets dx-avatar so postCloneReddit
      // can hoist it out before sanitisation drops the anchor.
      credit.querySelectorAll('a').forEach(a => {
        const txt = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!/^go to /i.test(txt)) return;
        const subredditImg = a.querySelector('img');
        if (subredditImg) appendClass(subredditImg, 'dx-avatar');
        appendClass(a, 'dx-excl');
      });
      // Drop the standalone back-arrow link/button. Reddit wraps it as a
      // shreddit-async-loader > a/button with an SVG child + text "Back".
      // Walk all descendants and tag the highest container whose entire
      // textContent matches a known chrome label.
      const CHROME_TEXT = /^(back|locked|stickied|pinned|archived|nsfw|spoiler|join|joined)$/i;
      credit.querySelectorAll('*').forEach(el => {
        const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (txt.length > 0 && txt.length < 30 && CHROME_TEXT.test(txt) && el.querySelector('svg')) {
          appendClass(el, 'dx-excl');
        }
      });
      // Drop aria-label-only badge SVGs (Locked / Stickied / Pinned post).
      credit.querySelectorAll('svg[aria-label]').forEach(svg => {
        const label = (svg.getAttribute('aria-label') ?? '').toLowerCase();
        if (/locked|stickied|pinned|archived|nsfw|spoiler/.test(label)) {
          appendClass(svg, 'dx-excl');
        }
      });
    }
    const footer = post.querySelector('[slot="post-footer"]');
    if (footer) appendClass(footer, 'dx-stats');

    // Reddit ships image posts as `<post-media-image>` containing 2-3 <img>
    // tags (blur-preview + main + hidden lightbox source). Tag the empty-alt
    // blur preview as dx-excl so only the user-facing image survives. The
    // generic dedupAdjacentImages pass in sanitiseTreeInPlace also handles
    // this, but tagging here is more precise — it catches the right img by
    // semantic role (empty alt = decorative blur), not by URL guessing.
    post.querySelectorAll('post-media-image img[alt=""], shreddit-aspect-ratio img[alt=""], picture img[alt=""]').forEach(img => {
      appendClass(img, 'dx-excl');
    });
  }

  // Each comment. Avatar lives in its own [slot="commentAvatar"] sibling, not
  // inside commentMeta — so dx-header (which expects avatar+name as direct
  // children of one wrapper) doesn't apply. Use dx-byline for the meta strip.
  root.querySelectorAll('shreddit-comment').forEach(cmt => {
    appendClass(cmt, 'dx-post');
    const meta = cmt.querySelector('[slot="commentMeta"]');
    if (meta) appendClass(meta, 'dx-byline');
    const action = cmt.querySelector('[slot="actionRow"]');
    if (action) appendClass(action, 'dx-stats');
    const avatarImg = cmt.querySelector('[slot="commentAvatar"] img');
    if (avatarImg) appendClass(avatarImg, 'dx-avatar');
  });

  // "N more replies" lazy-loaders: Reddit renders the same label up to three
  // times per collapsed branch (a [slot="loading"] div, the permalink anchor,
  // and the faceplate-partial wrapper), and each copy lands in a grid gutter
  // that collapses to a letter-per-line strip after sanitisation. The visual
  // target has no lazy-load affordances — drop them all. Scoped to slots
  // starting with "children" so the loader wrapper matches but the top-level
  // comment-tree partial (different slot) never does.
  root.querySelectorAll(
    'shreddit-comment faceplate-partial[slot^="children"], shreddit-comment [slot="loading"], shreddit-comment a[slot="more-comments-permalink"]',
  ).forEach(el => appendClass(el, 'dx-excl'));

  // The bare "Sort by:" label span sits outside the dropdown the CHROME_LABELS
  // pass below catches — drop it by exact text.
  root.querySelectorAll('span, div').forEach(el => {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (/^sort by:?$/i.test(t) && !el.querySelector('div, span')) appendClass(el, 'dx-excl');
  });

  // Drop the comment sort/search custom elements wholesale — they're pure
  // chrome and carry tooltip/aria text ("Open comment sort options", "Best")
  // in slotted <div>s that the label-based pass below can't reach (it only
  // walks a/button/[role=button], not shreddit-sort-dropdown's tooltip slot).
  root.querySelectorAll('shreddit-sort-dropdown, shreddit-search-dropdown, shreddit-comments-sort-dropdown').forEach(el => appendClass(el, 'dx-excl'));

  // Drop noisy SPA chrome that sits inside <main>: sort dropdown, search box,
  // "Reply" / "Share" / "Report" comment-action buttons, the floating bottom
  // "Back to top" pill. Reddit names each via `aria-label` or `name=` attrs.
  const CHROME_LABELS = /^(back|share|report|open comment sort options|search comments|sort by|moderation|view more comments|join|continue with)/i;
  root.querySelectorAll('a, button, faceplate-dropdown-menu, faceplate-search-input, [role="button"]').forEach(el => {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (label && CHROME_LABELS.test(label)) appendClass(el, 'dx-excl');
  });

  // Drop the back-arrow chrome that sits at the top of <main> on comment
  // pages. Reddit renders it via a custom element with its OWN shadow root
  // (`<shreddit-back-button>` / `<shreddit-async-loader>`), so the "Back"
  // text isn't visible on the live light DOM — it only materializes after
  // deepCloneWithShadow inlines the shadow children. Tagging the host with
  // dx-excl drops the whole subtree including its shadow children in the
  // clone (the EXCL_MARKER attr is set on the host, removeMarked drops it).
  const mainRoot = root.querySelector('main#main-content') ?? root.querySelector('main');
  if (mainRoot) {
    // Reddit's known back-arrow custom elements + plain anchors with aria-label="Back".
    // `pdp-back-button` is the current Reddit shadow-DOM host (the "Back"
    // button isn't visible in light DOM, only after deepCloneWithShadow
    // inlines its shadow children — tagging the host with dx-excl drops the
    // whole subtree, shadow included).
    mainRoot.querySelectorAll('pdp-back-button, shreddit-back-button, shreddit-async-loader[bundlename*="back" i]').forEach(el => appendClass(el, 'dx-excl'));
    // Drop ads + ad chrome that sit inside <main> alongside the post and
    // comments (sponsored shelves, promoted-link cards). All of these render
    // as custom elements with "ad" in the tag name.
    mainRoot.querySelectorAll('shreddit-comments-page-ad, shreddit-ad-post, shreddit-promoted-communities, shreddit-related-posts, shreddit-recommended-posts').forEach(el => appendClass(el, 'dx-excl'));
    mainRoot.querySelectorAll('a[aria-label], button[aria-label], [aria-label]').forEach(el => {
      const label = (el.getAttribute('aria-label') ?? '').trim().toLowerCase();
      if (label === 'back') appendClass(el, 'dx-excl');
    });
    // Fallback: anything that sits BEFORE shreddit-post in <main> and is not
    // shreddit-post itself is page chrome (Reddit's comments page only has
    // the post + comment tree as content; the back-link sits above).
    const sPost = mainRoot.querySelector('shreddit-post');
    if (sPost) {
      Array.from(mainRoot.children).forEach(child => {
        if (child === sPost) return;
        // Stop once we reach the post — anything before is chrome.
        if (child.compareDocumentPosition(sPost) & Node.DOCUMENT_POSITION_FOLLOWING) {
          appendClass(child, 'dx-excl');
        }
      });
    }
  }

  return mainRoot ?? undefined;
}

/**
 * Tag youtube.com watch pages. YT's content lives in `<ytd-watch-flexy>` with
 * `<div id="primary-inner">` as the actual content column (title, description,
 * comments) and `<div id="secondary">` as the "Up next" sidebar — the latter is
 * what we want to drop. YT uses Polymer custom elements, no `<aside>` or ARIA
 * role on the rail.
 *
 * Stamps:
 *   - `dx-post` on the title block (`#above-the-fold`) and description block
 *   - `dx-post` on each top-level `<ytd-comment-thread-renderer>`
 *   - `dx-header` on the comment avatar + author header inside each comment
 *   - `dx-stats` on the comment action row
 *
 * Returns `#primary-inner` as the narrowed root so the entire `#secondary`
 * sidebar is excluded.
 */
function tagYoutube(root: Document | Element): Element | void {
  const primaryInner = root.querySelector('#primary-inner');
  if (!primaryInner) return undefined;

  // Read the live player's poster URL so postCloneYoutube can use it
  // when synthesising the hero <figure> on the clone. We do NOT mutate
  // the live player here — `player.replaceWith(...)` on the live document
  // breaks YouTube's SPA (the player stops responding to navigation
  // between videos until the page is reloaded).
  const player = primaryInner.querySelector('#player, #player-container, ytd-player');
  ytLivePosterUrl = player?.querySelector('video[poster]')?.getAttribute('poster') ?? null;

  // YT's content column is a busy stack of widgets: title, action strip,
  // description, chapters chips, "Shorts remixing this video", merch,
  // transcript pull-out, channel videos, then comments. Most are interactive
  // engagement panels that sanitise into huge SVG icons with no useful text.
  // Build an allowlist of slots we DO want, then exclude every direct child
  // of #primary-inner / #below not in that allowlist. The synthetic <figure>
  // we just inserted in place of the player is allowed by being a <figure>.
  // Keep IDs: title, description, comments, AND #player (we'll swap it with
  // a synthetic poster <figure> in postCloneYoutube — must survive the
  // dx-excl pass that drops everything else).
  const KEEP_IDS = new Set(['above-the-fold', 'title', 'description-inline-expander', 'description', 'comments', 'player', 'player-container']);
  const KEEP_TAGS = new Set(['ytd-comments', 'ytd-player', 'figure']);
  const isKept = (el: Element) => KEEP_IDS.has(el.id) || KEEP_TAGS.has(el.tagName.toLowerCase());

  const excludeNonKept = (parent: Element) => {
    Array.from(parent.children).forEach(child => {
      if (!isKept(child) && !child.querySelector('#above-the-fold, ytd-comments, #player, ytd-player')) {
        appendClass(child, 'dx-excl');
      }
    });
  };
  excludeNonKept(primaryInner);
  const below = primaryInner.querySelector('#below');
  if (below) excludeNonKept(below);

  const atf = primaryInner.querySelector('#above-the-fold');
  if (atf) appendClass(atf, 'dx-post');
  const desc = primaryInner.querySelector('#description-inline-expander, #description');
  if (desc) appendClass(desc, 'dx-post');

  // Mark the channel-row avatar so postCloneYoutube can find/lift it onto
  // the rebuilt 2-row column. (The actual restructure happens on the clone.)
  const ownerImg = primaryInner.querySelector('ytd-video-owner-renderer img');
  if (ownerImg) appendClass(ownerImg, 'dx-avatar');

  // Top-level comment threads. Stamp dx-post for visual separation, dx-header
  // for the author/avatar row, dx-stats for the like/reply action row.
  primaryInner.querySelectorAll('ytd-comment-thread-renderer').forEach(cmt => {
    appendClass(cmt, 'dx-post');
    const header = cmt.querySelector('#header, #header-author');
    if (header) appendClass(header, 'dx-header');
    const avatarImg = cmt.querySelector('#author-thumbnail img, yt-img-shadow img');
    if (avatarImg) appendClass(avatarImg, 'dx-avatar');
    const action = cmt.querySelector('#toolbar, ytd-comment-action-buttons-renderer');
    if (action) appendClass(action, 'dx-stats');
  });

  // Drop the action strip (Like / Dislike / Share / Save / Download / Clip /
  // Subscribe). It sanitises into huge SVG icons with one-word labels.
  primaryInner.querySelectorAll('#actions, #actions-inner, #subscribe-button, ytd-menu-renderer').forEach(el => appendClass(el, 'dx-excl'));

  // Drop YT's tooltip/badge shells — they duplicate visible text (channel
  // name appears as <a>jawed</a> + <tp-yt-paper-tooltip>jawed</tp-yt-paper-tooltip>)
  // or render large no-context glyphs. tp-yt-paper-tooltip is an a11y
  // duplicate; ytd-badge-supported-renderer wraps the verified checkmark.
  primaryInner.querySelectorAll('tp-yt-paper-tooltip').forEach(el => appendClass(el, 'dx-excl'));

  // Drop the rich-card widgets that sit inside the description expander or
  // alongside it: Chapters, "Shorts remixing this video", Channel Videos,
  // Transcript pull-out, Merch, Live Chat, Engagement Panels. These render as
  // wide horizontal lists with huge chevron / thumbnail SVGs and have no
  // useful text content for a static clip.
  primaryInner.querySelectorAll(
    'ytd-horizontal-card-list-renderer, ytd-rich-list-header-renderer, ytd-horizontal-list-renderer, ytd-reel-shelf-renderer, ytd-shelf-renderer, ytd-video-description-transcript-section-renderer, ytd-video-description-music-section-renderer, ytd-video-description-infocards-section-renderer, ytd-structured-description-content-renderer, ytd-clip-creation-renderer, ytd-location-description-renderer, ytd-engagement-panel-section-list-renderer, ytd-video-primary-info-renderer, ytd-video-secondary-info-renderer'
  ).forEach(el => appendClass(el, 'dx-excl'));

  // Drop the "...more" / "Show less" description-expander toggle buttons — they
  // survive as a bare "...moreShow less" text run under the description.
  primaryInner.querySelectorAll(
    '#expand, #collapse, tp-yt-paper-button#expand, tp-yt-paper-button#collapse, #more, #less',
  ).forEach(el => appendClass(el, 'dx-excl'));

  // Drop the Comments section header + its count/sort chrome when the comment
  // list itself is empty (comments load lazily and often haven't rendered at
  // capture time, leaving a lone "Comments" heading + "Sort by" control).
  const comments = primaryInner.querySelector('#comments, ytd-comments');
  if (comments && comments.querySelectorAll('ytd-comment-thread-renderer').length === 0) {
    appendClass(comments, 'dx-excl');
  }

  return primaryInner;
}

/**
 * Tag stackoverflow.com question pages. SO uses stable BEM-ish class names that
 * survive across builds (not hashed CSS-modules):
 *   - `#question` / `.answer`                  question + each answer post
 *   - `.s-prose`                               the post body prose
 *   - `.user-info`                             avatar + name + rep card
 *   - `.js-vote-count` / `.js-voting-container` vote arrows + count column
 *   - `.post-menu`                             "share / edit / follow" footer
 *
 * Stamps `dx-post` on the question and each answer for visual separation,
 * `dx-header` on each user-info card (avatar + name layout), `dx-stats` on the
 * post-menu footer. Returns `#mainbar` as the narrowed root so the left nav,
 * "Related Questions" rail, and StackExchange chrome are dropped.
 */
function tagStackOverflow(root: Document | Element): Element | void {
  const mainbar = root.querySelector('#mainbar');
  if (!mainbar) return undefined;

  // Question + each answer become a dx-post.
  mainbar.querySelectorAll('#question, .answer').forEach(post => {
    appendClass(post, 'dx-post');
    // The .user-info card has 4+ siblings (edit-link + avatar + name + rep +
    // badges). dx-header expects a 2-child avatar/name split and would squash
    // the first sibling into the 44px avatar column. dx-byline lays the whole
    // strip inline with gentle gaps, which matches SO's actual presentation.
    // Mark the avatar img directly so it still renders as a round 44px pin.
    post.querySelectorAll('.user-info, .post-signature').forEach(info => {
      appendClass(info, 'dx-byline');
      const avatar = info.querySelector('.user-gravatar32 img, .gravatar-wrapper-32 img, .user-gravatar64 img, img.gravatar, .avatar img');
      if (avatar) appendClass(avatar, 'dx-avatar');
    });
    post.querySelectorAll('.post-menu, .js-post-menu').forEach(menu => appendClass(menu, 'dx-stats'));
  });

  // Exclude SPA chrome and prompts that aren't content.
  mainbar.querySelectorAll('.js-post-issue, .js-post-notice, .suggested-edit, .s-notice, .js-vote-count, .js-voting-container').forEach(el => appendClass(el, 'dx-excl'));

  return mainbar;
}

type SiteTagger = (root: Document | Element) => Element | void;
// Optional post-clone transformer. Runs AFTER deepCloneWithShadow has built
// the detached clone but BEFORE sanitisation/inlining. Receives the cloned
// capture root. Use this for destructive mutations (replaceWith / restructure)
// that must not touch the live page — without this hook, mutating the live
// DOM in a tagger leaks into the user's actual session (e.g. swapping out
// YouTube's #player breaks playback).
type SitePostClone = (clone: Element) => void;

// Selector-anchor manifest (Phase 3.2). Each tagger declares the load-bearing
// live-DOM selectors it depends on — the ones a site redesign would silently
// break. `checkTaggerAnchors(host, doc)` runs them against a page and reports
// which matched zero elements, so a canary (or the graceful-degradation
// self-check) can name the exact dead selector instead of just "clip looks
// wrong". Keep this list to the selectors that anchor the tagger's core
// output (the post container, the avatar/name hooks) — not every incidental
// exclusion selector. If ALL anchors miss, the tagger produced nothing useful
// for this page and the pipeline should fall back to the generic path.
interface SiteTagger_Entry {
  match: (host: string) => boolean;
  tag: SiteTagger;
  postClone?: SitePostClone;
  name: string;
  anchors: string[];
}

const SITE_TAGGERS: SiteTagger_Entry[] = [
  {
    name: 'primal',
    match: h => /(^|\.)primal\.net$/i.test(h),
    tag: tagPrimal,
    anchors: ['[class*="_primaryNote_"]', '[class*="_noteThread_"]'],
  },
  {
    name: 'bsky',
    match: h => /(^|\.)bsky\.app$/i.test(h),
    tag: tagBsky,
    anchors: ['[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]', '[data-testid="userAvatarImage"]'],
  },
  {
    name: 'goodreads',
    match: h => /(^|\.)goodreads\.com$/i.test(h),
    tag: tagGoodreads,
    // /review/list/ delegates to tagGoodreadsList (server-rendered table) which
    // has a wholly different DOM, so its anchor is listed separately.
    anchors: ['.BookPage, table.tableList', '.BookPageTitleSection, tr[id^="review_"]'],
  },
  {
    name: 'reddit',
    match: h => /(^|\.)reddit\.com$/i.test(h),
    tag: tagReddit,
    postClone: postCloneReddit,
    anchors: ['shreddit-post', 'shreddit-comment'],
  },
  {
    name: 'youtube',
    match: h => /(^|\.)youtube\.com$/i.test(h),
    tag: tagYoutube,
    postClone: postCloneYoutube,
    anchors: ['#primary-inner', 'ytd-video-owner-renderer, #owner'],
  },
  {
    name: 'stackoverflow',
    match: h => /(^|\.)stackoverflow\.com$/i.test(h),
    tag: tagStackOverflow,
    anchors: ['#mainbar', '#question, .answer', '.user-info, .post-signature'],
  },
];

/** One anchor selector's live-page match result. */
export interface AnchorResult {
  selector: string;
  count: number;
}

/** A tagger's anchor-check outcome against a given page. */
export interface TaggerAnchorReport {
  name: string;
  anchors: AnchorResult[];
  /** Selectors that matched zero elements — the dead ones. */
  dead: string[];
  /** True when EVERY anchor missed: the tagger is effectively broken here. */
  allDead: boolean;
}

/**
 * Run the anchor manifest for the tagger matching `host` against `root`,
 * reporting per-selector match counts. Used by the weekly canary (Phase 3.1)
 * to name a dead selector on a site redesign, and by the post-capture
 * self-check to decide whether the tagger degraded to noise. Returns null when
 * no tagger matches the host. Shadow-DOM-aware via querySelectorAllDeep.
 */
export function checkTaggerAnchors(host: string, root: Document | Element): TaggerAnchorReport | null {
  const entry = SITE_TAGGERS.find(t => t.match(host));
  if (!entry) return null;
  const anchors: AnchorResult[] = entry.anchors.map(selector => {
    let count = 0;
    try {
      count = querySelectorAllDeep(root, selector).length;
    } catch {
      count = 0; // an invalid selector counts as dead, not a crash
    }
    return { selector, count };
  });
  const dead = anchors.filter(a => a.count === 0).map(a => a.selector);
  return { name: entry.name, anchors, dead, allDead: dead.length === anchors.length };
}

/**
 * Apply the matching site tagger (if any) to the document. Called from
 * extractArticle before the layout-finder/Readability path runs so the
 * captured HTML carries dx-* markers regardless of which tier wins.
 * Sets siteTaggerActive (so the generic semantic-structure pass is skipped)
 * and siteTaggerRoot (the narrowed capture root, when the tagger returns one).
 */
/**
 * Apply the active site-tagger's clone-side transforms to a detached clone /
 * fragment. Shared by extractArticle (Tier 1, 1.5), extractSelection, and
 * extractFullPage so all three formats benefit from site tagger work.
 *
 * Order matters — postClone must run BEFORE removeMarked so it can lift
 * content (e.g. the Reddit subreddit avatar) out of `dx-excl`'d wrappers
 * before those wrappers are pruned.
 *
 * Steps:
 *   1. Promote `.dx-excl` classes to `EXCL_MARKER` attrs on the clone. The
 *      site tagger ran on the LIVE DOM and may have stamped `dx-excl` on
 *      elements inside the soon-to-be-cloned subtree; promoting them now
 *      lets `removeMarked` (step 3) drop them as a unit.
 *   2. Run the site tagger's `postClone` callback (if any) on the clone.
 *   3. Drop EXCL_MARKER'd elements.
 *
 * Caller is responsible for: `markExcluded` on the live DOM (for hidden /
 * fixed-positioned chrome), `annotateLiveImageSizes` cleanup, sanitisation,
 * and downstream image inlining. This helper only handles the site-tagger
 * portion of the clone pipeline.
 */
function applyTaggerToClone(cloneRoot: Element | DocumentFragment): void {
  if (siteTaggerActive) {
    cloneRoot.querySelectorAll('.dx-excl').forEach(el => el.setAttribute(EXCL_MARKER, '1'));
  }
  if (siteTaggerPostClone) {
    try {
      // postClone signatures take Element, but DocumentFragment shares the
      // querySelectorAll surface our hooks use. Cast through.
      siteTaggerPostClone(cloneRoot as Element);
    } catch (err) {
      log(LL.WARN, 'Discerned: site tagger postClone failed:', err);
    }
  }
  removeMarked(cloneRoot);
}

// Test-only host override. Set by the test bridge in content.ts so fixture
// pages served from 127.0.0.1 can exercise the matching site tagger (which
// otherwise gates on the live hostname). Tree-shaken in production: the
// `__DISCERNED_TEST_BUILD__` guard around the setter in content.ts means the
// var is only ever written under the test build, and `?? window.location.hostname`
// keeps the production path identical.
let testHostOverride: string | null = null;
export function __setTestHostOverride(host: string | null): void {
  if (__DISCERNED_TEST_BUILD__) testHostOverride = host;
}

// Tier 0 (Twitter/X) gates on the real page URL, which fixture pages served
// from 127.0.0.1 can never match — unlike SITE_TAGGERS, which only need a
// hostname override. This lets fixture-visual specs pass hostOverride:
// 'x.com' (etc.) to exercise extractTweet() against a saved DOM snapshot.
// Tree-shaken to the plain regex test in production (testHostOverride is
// always null when __DISCERNED_TEST_BUILD__ is false).
function isTweetHost(url: string): boolean {
  if (testHostOverride && /(^|\.)(twitter|x)\.com$/i.test(testHostOverride)) return true;
  return /^https?:\/\/(www\.)?(twitter|x)\.com\//i.test(url);
}

function applySiteTagger(): boolean {
  // Reset all before the loop so a non-matching capture doesn't inherit
  // a prior page's tagger state (the module-level vars persist across
  // captures in long-lived content-script lifetimes / SPA navigations).
  siteTaggerActive = false;
  siteTaggerRoot = null;
  siteTaggerPostClone = null;
  const host = testHostOverride ?? window.location.hostname;
  for (const t of SITE_TAGGERS) {
    if (t.match(host)) {
      // Graceful degradation (Phase 3.4): before running the tagger, check its
      // anchor manifest against the live page. If EVERY load-bearing selector
      // matches zero elements the site has redesigned out from under us — the
      // tagger would stamp nothing useful and only risk mis-scoping the clip.
      // Skip it and let the generic pipeline (layout finder / Readability)
      // handle the page, naming the dead selectors at WARN so a canary run or
      // the user's console pinpoints exactly what broke.
      const report = checkTaggerAnchors(host, document);
      if (report && report.allDead) {
        log(LL.WARN, `Discerned: ${t.name} tagger anchors all dead — falling back to generic pipeline. Dead selectors: ${report.dead.join(' | ')}`, 'url:', window.location.href);
        return false;
      }
      if (report && report.dead.length > 0) {
        log(LL.WARN, `Discerned: ${t.name} tagger has ${report.dead.length}/${report.anchors.length} dead anchor(s) (site may have partially redesigned): ${report.dead.join(' | ')}`, 'url:', window.location.href);
      }
      log(LL.DEBUG, `Discerned: applying ${t.name} site tagger`, 'url:', window.location.href);
      try {
        const root = t.tag(document);
        siteTaggerRoot = root ?? null;
        siteTaggerPostClone = t.postClone ?? null;
        if (root) log(LL.DEBUG, `Discerned: ${t.name} tagger returned narrowed root <${root.tagName.toLowerCase()}>`, 'url:', window.location.href);
        return true;
      } catch (err) {
        log(LL.WARN, `Discerned: ${t.name} tagger failed:`, err);
        return false;
      }
    }
  }
  return false;
}

// Module-level flag: true when applySiteTagger() found a match for this URL.
// tagSemanticStructure checks this and skips the generic pass — the site
// tagger has authoritative knowledge for this page.
let siteTaggerActive = false;

// Set by applySiteTagger when the matching tagger returns a narrowed capture
// root. extractArticle uses it in preference to the generic layout finder.
let siteTaggerRoot: Element | null = null;

// Set by applySiteTagger when the matching tagger registered a postClone
// callback. extractArticle runs it on the cloned capture root after
// deepCloneWithShadow + removeMarked but before sanitisation. Use for
// destructive mutations that must not leak into the live page (YT player
// replacement, Reddit byline column rebuild).
let siteTaggerPostClone: SitePostClone | null = null;

// Captured by tagYoutube on the LIVE page and consumed by postCloneYoutube
// on the clone. The live <video> element's `poster` attribute is the
// highest-resolution thumbnail YT has cached for the current video; the
// clone tree no longer has the live <video>, so we have to read it before
// the clone is built.
let ytLivePosterUrl: string | null = null;

/**
 * Post-clone transformer for Reddit. Runs on the detached clone after
 * removeMarked has dropped chrome but BEFORE sanitisation. Restructures the
 * dx-byline strip into avatar + two-row column (subreddit row on top,
 * author row below) to match Reddit's native visual.
 *
 * Why on the clone, not live DOM: Reddit's SPA reacts to subtree mutations
 * inside <shreddit-post>, so reparenting nodes on the live page can desync
 * the framework. The clone is detached and safe to mutate freely.
 */
function postCloneReddit(clone: Element): void {
  const credit = clone.querySelector('.dx-byline');
  if (!credit) return;

  // Hoist subreddit avatar (.dx-avatar nested inside the soon-to-be-dropped
  // "Go to" link) to be a direct child of dx-byline. Runs BEFORE removeMarked
  // so the avatar img is still reachable inside its dx-excl'd <a> wrapper.
  let subredditImg = credit.querySelector(':scope > img.dx-avatar');
  if (!subredditImg) subredditImg = credit.querySelector('img.dx-avatar');
  if (subredditImg && subredditImg.parentElement !== credit) {
    credit.insertBefore(subredditImg, credit.firstChild);
  }

  // Locate the surviving subreddit-link <a> (text starts with "r/") and the
  // author-link <a> (href contains /user/). Build a clean two-row column.
  const subredditAnchor = Array.from(credit.querySelectorAll('a')).find(a => {
    const href = a.getAttribute('href') ?? '';
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    return /^\/r\/[^/]+\/?$/i.test(href.replace(/^https?:\/\/[^/]+/, '')) &&
           /^r\//i.test(text) && !a.querySelector('img');
  });
  const authorAnchor = Array.from(credit.querySelectorAll('a')).find(a => {
    const href = a.getAttribute('href') ?? '';
    return /\/user\/[^/]+\/?$/i.test(href.replace(/^https?:\/\/[^/]+/, ''));
  });
  if (!subredditAnchor && !authorAnchor) return;

  const col = clone.ownerDocument!.createElement('div');
  col.className = 'dx-byline-col';
  const row1 = clone.ownerDocument!.createElement('div');
  row1.className = 'dx-byline-row dx-byline-row--sub';
  const row2 = clone.ownerDocument!.createElement('div');
  row2.className = 'dx-byline-row dx-byline-row--author';
  if (subredditAnchor) {
    // Pull subreddit anchor + its trailing "• Nh ago" sibling text into row1.
    const ageSpan = subredditAnchor.closest('span')?.parentElement;
    if (ageSpan && ageSpan.tagName === 'SPAN') {
      row1.appendChild(ageSpan.cloneNode(true));
    } else {
      row1.appendChild(subredditAnchor.cloneNode(true));
    }
  }
  if (authorAnchor) {
    row2.appendChild(authorAnchor.cloneNode(true));
  }
  col.appendChild(row1);
  col.appendChild(row2);

  const avatarEl = credit.querySelector(':scope > img.dx-avatar');
  if (avatarEl && avatarEl.nextSibling) {
    credit.insertBefore(col, avatarEl.nextSibling);
  } else {
    credit.appendChild(col);
  }
  // Drop every remaining direct child of credit that isn't avatar/col.
  Array.from(credit.children).forEach(child => {
    if (child !== avatarEl && child !== col) child.remove();
  });
}

/**
 * Post-clone transformer for YouTube. Runs on the detached clone after
 * removeMarked. Replaces the (still-present) #player subtree with a
 * synthetic <figure><a><img></a></figure> hero, using the live player's
 * <video poster=...> URL captured at tag time (falling back to YT's
 * hqdefault.jpg derivation).
 *
 * Why on the clone, not live DOM: `player.replaceWith(...)` on the live
 * page breaks YouTube's SPA — the player stops responding to navigation
 * between videos. The clone is detached and safe to mutate.
 */
function postCloneYoutube(clone: Element): void {
  const player = clone.querySelector('#player, #player-container, ytd-player');
  if (!player) return;
  const videoId = new URL(window.location.href).searchParams.get('v');
  if (!videoId) {
    player.remove();
    return;
  }
  const posterUrl = ytLivePosterUrl && /^https?:\/\//.test(ytLivePosterUrl)
    ? ytLivePosterUrl
    : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const doc = clone.ownerDocument!;
  const figure = doc.createElement('figure');
  const link = doc.createElement('a');
  link.setAttribute('href', `https://www.youtube.com/watch?v=${videoId}`);
  const img = doc.createElement('img');
  img.setAttribute('src', posterUrl);
  img.setAttribute('alt', 'Video thumbnail');
  img.setAttribute('width', '1280');
  img.setAttribute('height', '720');
  link.appendChild(img);
  figure.appendChild(link);
  player.replaceWith(figure);

  // Restructure the channel header into avatar + 2-row column (channel
  // name on top, subscriber count below). Same shape as Reddit's credit-bar.
  const owner = clone.querySelector('ytd-video-owner-renderer');
  if (owner) {
    const avatarImg = owner.querySelector('img');
    if (avatarImg) avatarImg.classList.add('dx-avatar');
    // Pick the channel-name anchor: an <a href="/@channel"> with VISIBLE TEXT
    // (not the avatar-wrapping anchor whose only child is the <img>).
    const channelAnchor = Array.from(owner.querySelectorAll('a[href*="/@"], ytd-channel-name a, #channel-name a')).find(a => {
      const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text.length > 0 && !a.querySelector('img');
    });
    const subscriberSpan = Array.from(owner.querySelectorAll('*')).find(el => {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return /subscribers?$/i.test(t) && t.length < 30 && el.children.length === 0;
    });
    if (channelAnchor || subscriberSpan) {
      const col = doc.createElement('div');
      col.className = 'dx-byline-col';
      const row1 = doc.createElement('div');
      row1.className = 'dx-byline-row dx-byline-row--sub';
      const row2 = doc.createElement('div');
      row2.className = 'dx-byline-row dx-byline-row--author';
      if (channelAnchor) row1.appendChild(channelAnchor.cloneNode(true));
      if (subscriberSpan) row2.appendChild(subscriberSpan.cloneNode(true));
      col.appendChild(row1);
      col.appendChild(row2);

      // Wrap owner content as dx-byline (its own classList) + avatar + col.
      owner.classList.add('dx-byline');
      // Drop everything currently in owner except the avatar image.
      Array.from(owner.children).forEach(child => {
        if (!child.contains(avatarImg as Node)) child.remove();
      });
      // If avatarImg is nested, hoist it to be a direct child.
      if (avatarImg && avatarImg.parentElement !== owner) {
        // Drop avatar's wrapping anchor/etc. first.
        let cur = avatarImg.parentElement;
        owner.insertBefore(avatarImg, owner.firstChild);
        while (cur && cur !== owner && cur.children.length === 0) {
          const parent = cur.parentElement;
          cur.remove();
          cur = parent;
        }
      }
      owner.appendChild(col);
    }
  }
}

// ── Semantic structure tagging (generic fallback) ────────────────────────────
//
// Live pages use flexbox + class-scoped CSS to lay out headers (avatar | name)
// and quoted-post cards. After sanitisation strips those classes, default
// block flow stacks everything vertically and links underline their children.
// Stamp our own `dx-*` class markers on detected structures so the web app's
// CSS can restore the intended layout.

const HEADER_AVATAR_MIN_PX = 24;
const HEADER_AVATAR_MAX_PX = 128;
const HEADER_NAME_MAX_CHARS = 80;
const QUOTE_MIN_TEXT_CHARS = 40;
const STATS_MIN_ICON_SIBLINGS = 3;

function appendClass(el: Element, token: string): void {
  const existing = el.getAttribute('class') ?? '';
  if (existing.split(/\s+/).includes(token)) return;
  el.setAttribute('class', existing ? `${existing} ${token}` : token);
}

/** True when img's authored width AND height fall in the avatar size band. */
function isAvatarSizedImg(img: Element): boolean {
  const w = parseInt(img.getAttribute('width') ?? '0', 10);
  const h = parseInt(img.getAttribute('height') ?? '0', 10);
  return w >= HEADER_AVATAR_MIN_PX && w <= HEADER_AVATAR_MAX_PX &&
         h >= HEADER_AVATAR_MIN_PX && h <= HEADER_AVATAR_MAX_PX;
}

/**
 * True if the element directly contains a small image (avatar-sized). Also
 * guards against treating a content gallery as an "avatar branch": when the
 * element holds 2+ images of similar size, it's a sequence of content tiles
 * (Wikipedia's "Bitcoin logos in 2009 and 2010" pair, Goodreads cover sliders,
 * etc.), not an avatar slot. Returns the first avatar-shaped image, or null.
 */
function hasAvatarImage(el: Element): HTMLImageElement | null {
  // (1) Bare-img child pattern: the element IS an avatar-sized <img>.
  // Stansberry's author block uses <span><img><a></a></span> — the img is a
  // direct sibling of the name link, not wrapped in its own container.
  if (el.tagName.toLowerCase() === 'img') {
    return isAvatarSizedImg(el) ? (el as HTMLImageElement) : null;
  }
  // (2) Wrapped-img pattern: primal/bsky/etc. nest the avatar in a container.
  // Reject branches with multiple sized images — that's a gallery, not an avatar.
  const sized = Array.from(el.querySelectorAll('img')).filter(img => {
    const w = parseInt(img.getAttribute('width') ?? '0', 10);
    const h = parseInt(img.getAttribute('height') ?? '0', 10);
    return w > 0 && h > 0;
  });
  if (sized.length > 1) return null;
  for (const img of sized) {
    if (isAvatarSizedImg(img)) return img as HTMLImageElement;
  }
  return null;
}

/**
 * Generic page-chrome stripper. Removes (not unwraps) navigation/aside/landmark
 * regions from the captured clone BEFORE sanitisation gets a chance to unwrap
 * them and promote their text content into the article. Without this, the
 * Wikipedia TOC, Reddit's left/right rails, Stack Overflow's right sidebar,
 * and YouTube's "Up next" all leak in as plain-text rows after sanitisation.
 *
 * Conservative on which tags get dropped:
 *
 *   - `<nav>`, `<aside>` — unambiguous chrome.
 *   - `[role="navigation"|"complementary"|"banner"|"search"|"contentinfo"]` —
 *     ARIA landmarks for chrome regions.
 *
 * Deliberately NOT stripped:
 *
 *   - `<header>` / `<footer>` — these legitimately contain article byline +
 *     engagement counters (ZeroHedge, Substack, Medium). The sanitiser knows
 *     how to promote them to `<div>` when they carry trusted `dx-*` classes.
 *   - Anything inside a site-tagger-supplied root (already authoritatively
 *     scoped to content).
 */
function stripPageChrome(root: Element): void {
  const STRIP_SELECTOR =
    'nav, aside, [role="navigation"], [role="complementary"], [role="banner"], [role="search"], [role="contentinfo"]';
  const dropped = Array.from(root.querySelectorAll(STRIP_SELECTOR));
  dropped.forEach(el => el.remove());
  if (dropped.length > 0) {
    log(LL.DEBUG, `Discerned: stripPageChrome removed ${dropped.length} landmark element(s)`, 'url:', window.location.href);
  }
}

/**
 * Walk the captured tree and stamp semantic class markers:
 *
 *   - `dx-header`: a container element whose direct children include both an
 *     avatar-sized image and a short text block. Web CSS lays this out as a
 *     horizontal flex row instead of stacked blocks.
 *
 *   - `dx-quote`: an <a> element wrapping a multi-element block (i.e. used as
 *     a card link, not a text link). Web CSS resets text-decoration inside
 *     and gives the block a subtle border/padding so it reads as quoted.
 *
 *   - `dx-stats`: a parent of ≥ 3 sibling action elements that each contain
 *     an SVG or button. Web CSS lays this out as an inline-flex row.
 */
function tagSemanticStructure(root: Element): void {
  // Skip the generic pass entirely when a site-specific tagger has already
  // marked the page authoritatively.
  if (siteTaggerActive) return;

  // Drop chrome-link icons that survive sanitisation. Pattern: <a> with a
  // known chrome destination AND no real text content (icon-only buttons:
  // Google "preferred source" stars, share-to-X icons, RSS icons, etc.).
  // Removed first so subsequent passes don't see them as siblings to
  // structural elements.
  const CHROME_HREF_RE = /\b(google\.com\/preferences|facebook\.com\/share|x\.com\/share|twitter\.com\/share|truthsocial\.com\/intent|threads\.net\/intent|mailto:\?|whatsapp:|tg:\/\/|linkedin\.com\/share)/i;
  root.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') ?? '';
    if (!CHROME_HREF_RE.test(href)) return;
    const linkText = (a.textContent ?? '').replace(/\s+/g, '').trim();
    if (linkText.length === 0) a.remove();
  });

  // Quotes first — an <a> with substantial nested content. Pre-sanitisation,
  // before <button>/<svg> children are unwrapped, so the structure is intact.
  root.querySelectorAll('a').forEach(a => {
    const elementChildCount = a.querySelectorAll('*').length;
    const text = (a.textContent ?? '').trim();
    const hasMedia = !!a.querySelector('img, video, picture');
    // A real link is short text inside an <a>. A "card link" wraps several
    // elements OR is long-form text plus media — that's a quoted post.
    if ((elementChildCount >= 3 && text.length >= QUOTE_MIN_TEXT_CHARS) ||
        (hasMedia && text.length >= QUOTE_MIN_TEXT_CHARS)) {
      appendClass(a, 'dx-quote');
    }
  });

  // A child that carries a substantial content image is media, not an action
  // icon. Gallery/carousel slides ship an expand <button> or svg arrow NEXT TO
  // the photo (How-to Geek's per-slide expand button is the reference case) —
  // without this guard the slide track matches the icon-row shape below, gets
  // dx-stats, and the markdown converter then drops every gallery photo from
  // the cast. Sized by width/height ATTRIBUTE (like collectCastImageUrls):
  // avatars annotate ~44px, icons 16–32px, content photos hundreds. Imgs with
  // no size attributes stay non-blocking so stats rows whose children carry
  // tiny preview avatars (primal's "top zaps") keep matching.
  const hasContentImage = (el: Element): boolean =>
    Array.from(el.querySelectorAll('img')).some(img => {
      const w = parseInt(img.getAttribute('width') ?? '', 10);
      const h = parseInt(img.getAttribute('height') ?? '', 10);
      if ((Number.isFinite(w) && w >= MIN_CAST_IMAGE_PX) ||
          (Number.isFinite(h) && h >= MIN_CAST_IMAGE_PX)) return true;
      // No size attributes — a <figure>-wrapped img is still declared content.
      return img.closest('figure') !== null;
    });

  // Belt to the guard above: carousel/gallery wrappers declare themselves in
  // their class names (this pass runs BEFORE sanitisation strips classes).
  // Never tag a slide track as an icon row, whatever its children hold.
  const CAROUSEL_CLASS_RE = /\b(splide|swiper|slick|glide|flickity|carousel|gallery|lightbox)/i;
  const insideCarousel = (el: Element): boolean =>
    !!el.closest('[class*="splide" i], [class*="swiper" i], [class*="slick" i], [class*="carousel" i], [class*="gallery" i], [class*="lightbox" i]') ||
    CAROUSEL_CLASS_RE.test(el.getAttribute('class') ?? '');

  // Stats rows BEFORE headers — so a stats container isn't also mis-tagged
  // as a header just because one of its many children happens to contain an
  // icon image (primal's "top zaps" preview avatars do exactly this). The
  // header pass below skips elements already tagged dx-stats.
  root.querySelectorAll('*').forEach(parent => {
    if (insideCarousel(parent)) return;
    const children = Array.from(parent.children);
    if (children.length < STATS_MIN_ICON_SIBLINGS) return;
    const actionChildren = children.filter(c =>
      (c.tagName.toLowerCase() === 'button' || c.querySelector('svg')) &&
      !hasContentImage(c)
    );
    if (actionChildren.length >= STATS_MIN_ICON_SIBLINGS &&
        actionChildren.length / children.length >= 0.6) {
      appendClass(parent, 'dx-stats');
    }
  });

  // Second pass — sites like Medium split the engagement glyph row into two
  // visual groups (e.g. [clap | responses | repost] and [bookmark | listen |
  // share]) separated by a spacer. Each group's siblings count < 3 individually
  // so the heuristic above misses one or both. Catch them by looking for
  // elements whose direct children are mostly action-shaped (svg/button OR an
  // <a>/<div> whose only element descendants are svg/button-shaped). When a
  // parent has ≥ 3 such children OR contains a dx-stats AND has multiple
  // action-shaped siblings, tag the parent too.
  const isActionShaped = (el: Element): boolean => {
    if (el.classList.contains('dx-stats')) return true;
    if (hasContentImage(el)) return false; // media slide, not a clickable icon
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'svg') return true;
    // An <a> or <div> that wraps a single svg/button (no real text content) is
    // effectively a clickable icon.
    const text = (el.textContent ?? '').replace(/\s+/g, '').trim();
    const hasIcon = !!el.querySelector('svg, button');
    return hasIcon && text.length <= 6;  // counts like "6" or "1.3K" allowed
  };
  root.querySelectorAll('*').forEach(parent => {
    if (parent.classList.contains('dx-stats')) return;
    if (insideCarousel(parent)) return;
    const children = Array.from(parent.children);
    if (children.length < 2) return;
    const actionLike = children.filter(isActionShaped);
    if (actionLike.length >= 2 && actionLike.length / children.length >= 0.6) {
      appendClass(parent, 'dx-stats');
    }
  });

  // Engagement-counter footer rows (ZeroHedge, Substack, Medium, etc.). The
  // canonical shape is 2+ sibling spans whose class names include "footerStat"
  // or "engagement" — each wraps an icon-font glyph + a number. Class names
  // get stripped by sanitisation, so we tag the parent now and right-align
  // it in CSS. The pattern is more permissive than dx-stats above because
  // these don't carry svg/button children — they use icon fonts (<i>) which
  // the sanitiser drops.
  root.querySelectorAll('*').forEach(parent => {
    const children = Array.from(parent.children);
    if (children.length < 2) return;
    const counters = children.filter(c => {
      const cls = (c as Element).className?.toString() ?? '';
      return /footerStat|engagement[A-Z_]|node[-_]?stat/i.test(cls);
    });
    // Require ALL/most children to be counters AND the parent not yet tagged.
    if (counters.length >= 2 &&
        counters.length / children.length >= 0.6 &&
        !parent.classList.contains('dx-stats')) {
      appendClass(parent, 'dx-stats');
      appendClass(parent, 'dx-stats--end');
    }
  });

  // Headers — find the DEEPEST element whose direct children are an avatar
  // branch (img, no significant text) and a name branch (short text, no
  // avatar). Walking the all-elements list in reverse hits deeper children
  // first; we skip any element that contains an already-tagged descendant,
  // so only the innermost match wins.
  const allElements = Array.from(root.querySelectorAll('*'));
  allElements.reverse();
  const headerTagged: Element[] = [];
  for (const el of allElements) {
    if (el.classList.contains('dx-stats')) continue;
    // Skip if a descendant has already been tagged — we want the innermost.
    if (headerTagged.some(t => el.contains(t) && el !== t)) continue;
    const children = Array.from(el.children);
    // A header has exactly 2 direct children (avatar + name). Some clients
    // include a third (timestamp). Reject anything wider — likely a feed row.
    if (children.length < 2 || children.length > 3) continue;
    let avatarChildIdx = -1;
    let nameChildIdx = -1;
    let stop = false;
    let avatarBranchCount = 0;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      // A stats child means this is not a header.
      if (c.classList.contains('dx-stats')) { stop = true; break; }
      const hasAvatar = !!hasAvatarImage(c);
      const text = (c.textContent ?? '').trim();
      if (hasAvatar) avatarBranchCount++;
      if (hasAvatar && text.length < 4) {
        if (avatarChildIdx === -1) avatarChildIdx = i;
      } else if (!hasAvatar && text.length > 0 && text.length <= HEADER_NAME_MAX_CHARS * 2) {
        if (nameChildIdx === -1) nameChildIdx = i;
      }
    }
    if (stop || avatarChildIdx < 0 || nameChildIdx < 0) continue;
    // Reject when multiple branches hold avatar-shaped images — that's a banner
    // or gallery (Wikipedia CentralNotice with twin side-banners, multi-author
    // bylines on news sites with each author's photo), not a single header row.
    if (avatarBranchCount > 1) continue;
    if (el.querySelectorAll('*').length > 40) continue;
    // When the avatar branch is a bare <img> (Stansberry-style author block),
    // require the name branch to be or contain an <a> — a byline link. Excludes
    // the figure/figcaption pattern (img + caption-text sibling) from being
    // mistagged as a header.
    const avatarChild = children[avatarChildIdx];
    if (avatarChild.tagName.toLowerCase() === 'img') {
      const nameChild = children[nameChildIdx];
      if (nameChild.tagName.toLowerCase() !== 'a' && !nameChild.querySelector('a')) continue;
    }
    appendClass(el, 'dx-header');
    headerTagged.push(el);
  }

  // Header-meta sibling — when the dx-header tagged above only contains
  // [avatar + name] but a NEARBY sibling/uncle holds the meta strip (e.g.
  // Medium's "25 min read · May 26, 2026" sits in a div next to the byline
  // group), tag it as dx-byline-meta so CSS can pull it flush under the
  // header in the name column. Look in:
  //   1. dx-header's next-sibling subtree
  //   2. dx-header's parent's next-sibling subtree
  // Both are searched for the first element whose direct text matches the
  // meta regex AND whose total text is short (<= 80 chars).
  const META_RE = /\b\d+\s*min\s*(read)?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i;
  const findMetaIn = (scope: Element | null | undefined): Element | null => {
    if (!scope) return null;
    // Skip if scope itself or any ancestor is a tweet-card — tweet cards have
    // their own footer with date that we don't want repurposed as the
    // article byline meta.
    if (scope.closest && scope.closest('.tweet-card')) return null;
    const all = Array.from(scope.querySelectorAll('*'));
    for (const candidate of all) {
      if (candidate.classList.contains('dx-stats')) continue;
      if (candidate.classList.contains('dx-header')) continue;
      // Don't pull meta from inside a tweet-card.
      if (candidate.closest('.tweet-card')) continue;
      const t = (candidate.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length === 0 || t.length > 80) continue;
      if (META_RE.test(t)) return candidate;
    }
    return null;
  };
  for (const el of headerTagged) {
    if (META_RE.test(el.textContent ?? '')) continue;  // already includes meta
    // Search the dx-header's immediate sibling subtree first, then its parent's
    // next-sibling subtree. Stop at the first element matching the meta regex.
    let meta = findMetaIn(el.nextElementSibling);
    if (!meta && el.parentElement) {
      meta = findMetaIn(el.parentElement.nextElementSibling);
    }
    if (meta) {
      appendClass(meta, 'dx-byline-meta');
      // Move the meta element INTO the dx-header's name column so it flows on
      // the same row as the author name. The name column is the second direct
      // child of dx-header (or the first non-first child if heuristics picked
      // a multi-child header). We append the meta as its last child.
      const children = Array.from(el.children);
      const nameColumn = children.length >= 2
        ? children.find((c, i) => i > 0 && !hasAvatarImage(c)) ?? children[1]
        : null;
      if (nameColumn && !nameColumn.contains(meta)) {
        nameColumn.appendChild(meta);
      }
    }
  }

  // Article-chrome widgets that survive sanitisation but aren't content:
  //   - <input type="range"> audio scrubbers (Amplitude.js, Polly TTS)
  //   - elements with data-mp3u (Polly TTS audio URL)
  // Remove them outright.
  root.querySelectorAll('[data-mp3u], input[type="range"]').forEach(el => {
    // Walk up to the closest container that's clearly the widget wrapper —
    // typically the parent of an <input type="range"> with sibling time/play.
    const widget = el.closest('[data-mp3u], [class*="amplitude" i], [id*="Polly" i]') ?? el;
    widget.remove();
  });

  // Avatar-less bylines (news sites: Breitbart, NYT, WaPo, etc.) — these
  // look like "Author Name and Author Name | Date | Counter" all on one line.
  // Detect: an element whose direct text/structure contains an <address> OR
  // an author-link <a> alongside a <time> element, total text < 200 chars,
  // no img descendants. Stamp dx-byline so CSS lays it as a single muted row.
  // Walk in reverse so we encounter deepest elements first; if a descendant
  // already has dx-byline, skip the ancestor (we want the tightest wrapper).
  const allEls = Array.from(root.querySelectorAll('*')).reverse();
  for (const parent of allEls) {
    if (parent.classList.contains('dx-byline')) continue;
    if (parent.classList.contains('dx-header')) continue;
    if (parent.classList.contains('dx-stats')) continue;
    if (parent.querySelector('.dx-byline')) continue;  // descendant already tagged
    const text = (parent.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > 200) continue;
    if (parent.querySelector('img')) continue;  // has avatar → handled by dx-header
    const hasAddress = !!parent.querySelector('address');
    const authorLinks = Array.from(parent.querySelectorAll('a')).filter(a => {
      const href = a.getAttribute('href') ?? '';
      return /\/author\/|\/by\/|\/profile\/|\/people\/|\/u\//i.test(href);
    });
    const hasTime = !!parent.querySelector('time');
    const looksByline = (hasAddress || authorLinks.length >= 1) && hasTime;
    if (!looksByline) continue;
    appendClass(parent, 'dx-byline');
  }
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
  // SVG icon glyphs — preserved so action/badge icons survive sanitisation on
  // sites that use inline SVG instead of font icons. <script> and <foreignObject>
  // are intentionally excluded.
  'svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'ellipse', 'defs', 'use', 'title', 'symbol',
]);
const ALLOWED_ATTRS_GLOBAL = new Set(['style', 'class']);
// Only class tokens with these prefixes survive sanitisation. `dx-*` is stamped
// by tagSemanticStructure() to carry layout hints (header rows, quoted-post
// cards, icon/stat rows) across the class-stripping boundary. `tweet-*` comes
// from the Twitter extractor. Both are added by our code, not the source page.
const TRUSTED_CLASS_PREFIXES = ['dx-', 'tweet-'];
const ALLOWED_ATTRS_PER_TAG: Record<string, Set<string>> = {
  a:   new Set(['href']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'data-dx-src']),
  // Note: keys here MUST be lowercase — sanitiseElement compares attr.name.toLowerCase().
  // SVG camelCase attrs (viewBox, gradientUnits, etc.) are written as their lowercased
  // form, which matches the lowercased-attribute-name lookup browsers do on HTML-parsed SVG.
  svg: new Set(['viewbox', 'xmlns', 'width', 'height', 'fill', 'stroke',
    'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'aria-label', 'role', 'focusable']),
  path: new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'fill-rule', 'clip-rule', 'opacity']),
  g: new Set(['fill', 'stroke', 'stroke-width', 'transform', 'opacity']),
  circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
  polyline: new Set(['points', 'fill', 'stroke', 'stroke-width']),
  polygon: new Set(['points', 'fill', 'stroke', 'stroke-width']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width']),
  use: new Set(['href', 'x', 'y', 'width', 'height']),
};

// Cap inline SVGs to guard against pathological icon-gallery pages bloating the
// stored event. A long social thread legitimately needs many: each post's action
// row (reply/repost/like/share/options) is ~5 small glyph SVGs, so a 40-reply
// thread carries ~200. Set the cap high enough to keep those while still bounding
// truly pathological pages.
const MAX_SVGS_PER_ARTICLE = 400;

function isSafeImageSrc(src: string): boolean {
  if (src.startsWith('data:image/')) return true;
  if (/^https:\/\//i.test(src)) return true;
  return false;
}

/**
 * Return a safe, absolute image src for storage, or null if the src is unsafe.
 * Site-relative paths (e.g. Next.js's "/_next/image?url=...") are resolved
 * against the source page's URL so the inliner can fetch them. Rejects
 * data:* (non-image), javascript:, and other non-fetchable schemes.
 */
function resolveImageSrc(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (isSafeImageSrc(trimmed)) return trimmed;
  if (/^(javascript|vbscript|file|data):/i.test(trimmed)) return null;
  try {
    const abs = new URL(trimmed, window.location.href).toString();
    return isSafeImageSrc(abs) ? abs : null;
  } catch {
    return null;
  }
}

function isSafeHref(href: string): boolean {
  if (/^https?:\/\//i.test(href)) return true;
  if (href.startsWith('#')) return true;
  if (href.startsWith('mailto:')) return true;
  return false;
}

/**
 * Return a safe, absolute href for storage, or null if the href is unsafe.
 * Site-relative paths (e.g. "/u/npub1...") are resolved against the source
 * page's URL so the stored clip's links survive after the user navigates
 * away. Rejects javascript:, data:, and other non-navigational schemes.
 */
function resolveHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (isSafeHref(trimmed)) return trimmed;
  // Reject dangerous schemes outright.
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return null;
  try {
    const abs = new URL(trimmed, window.location.href).toString();
    return isSafeHref(abs) ? abs : null;
  } catch {
    return null;
  }
}

function scrubStyle(value: string): string {
  return value
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/url\s*\(/gi, '')
    .replace(/-moz-binding/gi, '')
    .replace(/behavior\s*:/gi, '')
    // Percentage vertical padding is the aspect-ratio sizer hack (padding-%
    // resolves against WIDTH — no other use exists): a lazy-load wrapper
    // reserves the image's height with e.g. `padding-bottom: 56.25%` over an
    // absolutely-positioned img (How-to Geek's gallery is the reference case).
    // The clip render resets the img's positioning, so the reserved space
    // becomes inches of blank page above the photo — zero it at capture time.
    // A CSS-side rule can't do this precisely: `[style*="padding-top:"]
    // [style*="%"]` matches the substrings independently, so bsky rows with
    // `flex: 1 1 0%; padding-bottom: 4px` lose real padding (see globals.css).
    .replace(/padding-(top|bottom)\s*:\s*\d+(?:\.\d+)?%/gi, 'padding-$1: 0');
}

const IMG_LAYOUT_PROPS = [
  'position', 'float', 'top', 'right', 'bottom', 'left',
  'z-index', 'transform', 'translate', 'rotate', 'scale',
];

function scrubImgStyle(value: string): string {
  const el = document.createElement('div');
  el.setAttribute('style', scrubStyle(value));
  const stripped: string[] = [];
  for (const prop of IMG_LAYOUT_PROPS) {
    if (el.style.getPropertyValue(prop)) {
      stripped.push(prop);
      el.style.removeProperty(prop);
    }
  }
  if (stripped.length > 0) {
    log(LL.DEBUG, `Discerned: scrubImgStyle stripped [${stripped.join(', ')}] from img inline style`, 'url:', window.location.href);
  }
  return el.style.cssText;
}

// When these tags are unwrapped, their text content would otherwise glue to
// adjacent sibling text — e.g. <button>Replies (1)</button><button>Reposts
// (1)</button> becomes "Replies (1)Reposts (1)". Inserting space text nodes
// around the unwrapped children preserves the visual word boundary.
const SPACE_ON_UNWRAP = new Set([
  'button', 'label', 'dt', 'dd', 'summary', 'details', 'fieldset', 'legend',
  'nav', 'header', 'footer', 'aside', 'section', 'article',
]);

function sanitiseElement(element: Element, stripStyles = false) {
  const tagName = element.tagName.toLowerCase();

  if (!ALLOWED_TAGS.has(tagName)) {
    // If an unwrap target carries a trusted dx-*/tweet-* class (stamped by
    // tagSemanticStructure or a site tagger), the class encodes layout intent
    // we don't want to lose. Promote the element to a <div> instead of
    // unwrapping, so the class survives sanitisation and the layout CSS
    // applies. Examples: <footer dx-stats dx-stats--end> on news-site
    // engagement rows, <header dx-header> if a tagger ever picks one up.
    const cls = element.className?.toString() ?? '';
    const hasTrustedClass = cls.split(/\s+/).some(t =>
      t && TRUSTED_CLASS_PREFIXES.some(p => t.startsWith(p))
    );
    if (hasTrustedClass) {
      const div = document.createElement('div');
      for (const a of Array.from(element.attributes)) {
        try { div.setAttribute(a.name, a.value); } catch { /* ignore invalid */ }
      }
      while (element.firstChild) div.appendChild(element.firstChild);
      element.replaceWith(div);
      // Re-run sanitisation on the new <div> so its attributes get the
      // standard treatment (class-token filter, style scrub, etc.).
      sanitiseElement(div, stripStyles);
      return;
    }
    const children = Array.from(element.childNodes);
    const replacements: Node[] = SPACE_ON_UNWRAP.has(tagName)
      ? [document.createTextNode(' '), ...children, document.createTextNode(' ')]
      : children;
    element.replaceWith(...replacements);
    return;
  }

  const perTag = ALLOWED_ATTRS_PER_TAG[tagName] ?? new Set<string>();

  Array.from(element.attributes).forEach(attr => {
    const name = attr.name.toLowerCase();
    if (name === 'style' && stripStyles) { element.removeAttribute(attr.name); return; }
    const allowed = ALLOWED_ATTRS_GLOBAL.has(name) || perTag.has(name);
    if (!allowed) { element.removeAttribute(attr.name); return; }

    if (name === 'style') {
      const safe = tagName === 'img' ? scrubImgStyle(attr.value) : scrubStyle(attr.value);
      if (safe.trim()) element.setAttribute('style', safe);
      else element.removeAttribute('style');
    } else if (name === 'class') {
      // Keep only tokens stamped by our own capture pipeline (dx-* layout hints
      // and tweet-* from the Twitter extractor). Everything else — including
      // source-page hashed classes — is dropped.
      const kept = attr.value.split(/\s+/).filter(t =>
        t && TRUSTED_CLASS_PREFIXES.some(p => t.startsWith(p))
      );
      if (kept.length > 0) element.setAttribute('class', kept.join(' '));
      else element.removeAttribute('class');
    } else if (tagName === 'img' && name === 'src') {
      const resolved = resolveImageSrc(attr.value);
      if (resolved) element.setAttribute('src', resolved);
      else element.removeAttribute('src');
    } else if (tagName === 'a' && name === 'href') {
      const resolved = resolveHref(attr.value);
      if (resolved) {
        element.setAttribute('href', resolved);
        // Captured clips are rendered in our own UI; we never want a link
        // click to navigate the host page away from the library. Force
        // every preserved <a> to open in a new tab with a safe rel.
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      } else {
        element.removeAttribute('href');
      }
    }
  });
}

const SIZE_MARKER = 'data-discerned-sized';

// Stamped on live elements whose computed display is flex/grid. Their children
// sit visually apart on the source page, but once sanitisation strips the
// source classes the children collapse to adjacent inline boxes and their text
// runs together ("399M views21 years ago", "Imran Rahman-JonesTechnology
// reporter"). applyFlexSeparation() reads the marker on the clone and inserts
// space text nodes between the children before it is stripped.
const FLEXSEP_MARKER = 'data-discerned-flexsep';

/**
 * Write each live <img>'s rendered width/height onto the live element as
 * width/height attributes, so subsequent cloneNode(true) copies them into
 * the detached tree. Returns a cleanup() that removes the markers from the
 * live DOM after cloning. Must be called BEFORE cloneNode.
 *
 * Without this, sanitisation strips wrapper classes and the browser falls back
 * to intrinsic pixel size — making avatars huge and skewing column layouts.
 * The img tag's allowlist already passes width/height through sanitisation.
 *
 * Live-DOM mutation is the only reliable way to pair sizes across the
 * clone — cleanup steps like markExcluded/removeMarked can delete <img>s
 * (e.g. a sticky-header logo), breaking any index-based pairing on the clone.
 */
function annotateLiveImageSizes(liveRoot: Element): () => void {
  // Pierce open shadow roots so images inside e.g. <widget-media-content>
  // get rendered-size annotations too (otherwise they fall back to intrinsic
  // resolution after sanitisation strips wrapper classes).
  const liveImgs = querySelectorAllDeep(liveRoot, 'img') as HTMLImageElement[];
  const annotated: Array<{ img: HTMLImageElement; hadWidth: boolean; hadHeight: boolean }> = [];
  liveImgs.forEach(img => {
    const rect = img.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w <= 0 || h <= 0) return;
    const hadWidth = img.hasAttribute('width');
    const hadHeight = img.hasAttribute('height');
    if (!hadWidth) img.setAttribute('width', String(w));
    if (!hadHeight) img.setAttribute('height', String(h));
    img.setAttribute(SIZE_MARKER, '1');
    annotated.push({ img, hadWidth, hadHeight });
  });

  // Same annotate→clone→cleanup lifecycle for flex/grid containers, feeding
  // applyFlexSeparation() on the clone (see FLEXSEP_MARKER).
  const flexMarked: Element[] = [];
  forEachDeepElement(liveRoot, el => {
    if (el.childElementCount < 2) return;
    const d = window.getComputedStyle(el).display;
    let mark = d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
    if (!mark) {
      // Inline-by-default children (span/a) that the source styles as block
      // or inline-block sit visually apart on the page too — after class
      // stripping they revert to plain inline and their text runs together
      // (BBC's <span>Name</span><span>Role</span> byline).
      for (const c of Array.from(el.children)) {
        if (c.tagName !== 'SPAN' && c.tagName !== 'A') continue;
        const cd = window.getComputedStyle(c).display;
        if (cd === 'block' || cd === 'inline-block' || cd === 'list-item') { mark = true; break; }
      }
    }
    if (mark) {
      el.setAttribute(FLEXSEP_MARKER, '1');
      flexMarked.push(el);
    }
  });

  return () => {
    annotated.forEach(({ img, hadWidth, hadHeight }) => {
      if (!hadWidth) img.removeAttribute('width');
      if (!hadHeight) img.removeAttribute('height');
      img.removeAttribute(SIZE_MARKER);
    });
    flexMarked.forEach(el => el.removeAttribute(FLEXSEP_MARKER));
  };
}

/** Strip the size marker from a cloned tree (the marker attr survives cloneNode). */
function stripSizeMarkers(root: Element | DocumentFragment): void {
  (root as Element).querySelectorAll(`[${SIZE_MARKER}]`).forEach(el => el.removeAttribute(SIZE_MARKER));
}

/**
 * Try to draw the current frame of a cross-origin <video> by:
 * 1. Fetching the video src through the background worker (has <all_urls>),
 *    which returns the bytes as a data URI.
 * 2. Converting the data URI to a same-origin blob URL.
 * 3. Creating a scratch <video>, seeking to the same currentTime, and
 *    canvas-capturing from the blob-URL video (no SecurityError).
 * Times out after 8 s to avoid blocking capture on a slow/large video.
 */
async function captureVideoFrameViaBackground(
  srcUrl: string,
  currentTime: number,
  width: number,
  height: number,
): Promise<string | null> {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'FETCH_VIDEO_BLOB', src: srcUrl }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8_000)),
    ]) as { success: boolean; data?: { dataUri: string } };
    if (!res?.success || !res.data?.dataUri) return null;

    // Convert the data URI to a blob URL so the scratch <video> is same-origin.
    const dataUri = res.data.dataUri;
    const fetchRes = await fetch(dataUri);
    const blob = await fetchRes.blob();
    const blobUrl = URL.createObjectURL(blob);

    try {
      const dataUriOut = await new Promise<string | null>((resolve) => {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.src = blobUrl;
        const abort = setTimeout(() => resolve(null), 5_000);
        v.onseeked = () => {
          clearTimeout(abort);
          try {
            const c = document.createElement('canvas');
            c.width = width;
            c.height = height;
            c.getContext('2d')?.drawImage(v, 0, 0);
            const uri = c.toDataURL('image/jpeg', 0.85);
            resolve(uri && uri !== 'data:,' ? uri : null);
          } catch {
            resolve(null);
          }
        };
        v.onerror = () => { clearTimeout(abort); resolve(null); };
        v.addEventListener('loadedmetadata', () => { v.currentTime = currentTime; }, { once: true });
        v.load();
      });
      return dataUriOut;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch {
    return null;
  }
}

/**
 * Capture the current frame of every playing <video> in the live DOM as a
 * canvas data URI. Stamps a temporary `data-uuid` on each video so the result
 * survives cloning (the clone carries the attribute; the live element is the key
 * in the live DOM but the clone has no .readyState). Returns Map<uuid, dataUri>.
 * Must be called BEFORE deepCloneWithShadow — the clone has no active media.
 */
async function captureVideoFrames(root: Element | Document): Promise<Map<string, string>> {
  const frames = new Map<string, string>();
  let idx = 0;
  const videos = querySelectorAllDeep(root as Element, 'video') as HTMLVideoElement[];
  for (const video of videos) {
    if (video.readyState < 2 || video.videoWidth === 0) continue;

    // Stamp a stable uuid on the live element so the clone carries it.
    let uuid = video.getAttribute('data-uuid');
    if (!uuid) {
      uuid = `dcv-${Date.now()}-${idx++}`;
      video.setAttribute('data-uuid', uuid);
    }

    // Try direct canvas capture first (works for same-origin videos).
    let dataUri: string | null = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const uri = canvas.toDataURL('image/jpeg', 0.85);
      if (uri && uri !== 'data:,') dataUri = uri;
    } catch {
      // SecurityError for cross-origin video — fall through to background fetch.
    }

    // For cross-origin videos, fetch through background worker then canvas-capture
    // the blob URL (same-origin, no SecurityError).
    if (!dataUri) {
      const srcUrl = video.getAttribute('src') ?? video.querySelector('source')?.getAttribute('src') ?? '';
      if (srcUrl && /^https:/i.test(srcUrl)) {
        dataUri = await captureVideoFrameViaBackground(
          srcUrl, video.currentTime, video.videoWidth, video.videoHeight,
        );
      }
    }

    if (dataUri) frames.set(uuid, dataUri);
  }
  return frames;
}

/**
 * Replace Twitter's video player structure with a plain <img src="poster"> so that
 * GIFs and video thumbnails survive sanitisation. Replaces the nearest
 * [data-testid="tweetPhoto"] ancestor when present (which removes Twitter's aspect-ratio
 * sizer divs that would otherwise constrain the image size), otherwise replaces the
 * <video> element directly.
 *
 * liveFrames: canvas-captured frames from the live DOM (keyed on the live
 * <video> element via data-uuid or index). Pass the result of captureVideoFrames()
 * called before cloning.
 */
function substituteVideosWithPosters(root: Element | DocumentFragment, liveFrames?: Map<string, string>): void {
  Array.from((root as Element).querySelectorAll('video')).forEach(video => {
    // Prefer the HTML poster attribute, then a canvas frame captured from the
    // live video before cloning (keyed by data-uuid stamped on the live element).
    const uuid = video.getAttribute('data-uuid') ?? '';
    const framePoster = uuid ? liveFrames?.get(uuid) : undefined;
    const poster = video.getAttribute('poster') ?? framePoster ?? null;
    const tweetPhoto = video.closest('[data-testid="tweetPhoto"]');
    // Media Chrome player wrapper (<media-controller>) — replace the whole
    // wrapper so the inlined shadow-DOM controls (Media Chrome's "Pause" /
    // "Unmute" text nodes from its button shadow roots) don't leak into the
    // captured clip as visible text.
    const mediaController = video.closest('media-controller');
    const wrapper = tweetPhoto ?? mediaController ?? null;
    if (poster && isSafeImageSrc(poster)) {
      // Has a poster: swap the whole wrapper for a plain <img>.
      const img = document.createElement('img');
      img.src = poster;
      img.alt = 'Video';
      (wrapper ?? video).replaceWith(img);
      return;
    }
    // No usable poster. Try to produce a "▶ Video" link from the first <source>.
    const srcUrl = video.getAttribute('src') ??
      video.querySelector('source')?.getAttribute('src') ?? null;
    if (srcUrl && /^https:/i.test(srcUrl)) {
      const a = document.createElement('a');
      a.href = srcUrl;
      a.className = 'dx-video-link';
      a.textContent = '▶ Video';
      (wrapper ?? video).replaceWith(a);
    } else {
      if (wrapper) { wrapper.remove(); } else { video.remove(); }
    }
  });

  // Background-image video posters. Bluesky (and similar players) render a video
  // embed as a <div style="background-image:url(…thumbnail.jpg); background:#000">
  // with no <video>/<img>. Sanitisation strips `url(`, leaving a blank black box.
  // Pull the poster URL into a real <img> so it survives and gets inlined.
  (root as Element).querySelectorAll<HTMLElement>('[style*="background-image"]').forEach(el => {
    const url = el.style.backgroundImage.match(/https?:\/\/[^"')\s]+/)?.[0];
    if (!url || !/\.(jpe?g|png|webp|gif)/i.test(url) || !isSafeImageSrc(url)) return;
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Video';
    // Replace the player's aspect-ratio sizer wrapper when present so we don't
    // leave the empty black box around the new poster.
    const box = el.closest('[style*="aspect-ratio"]') ?? el;
    box.replaceWith(img);
  });
}

/**
 * Replace common CSS-sprite star-rating widgets with ★/☆ glyph runs.
 *
 * A widely-copied pattern (Goodreads, older Rails/jQuery sites, some review
 * plugins) renders a 5-star rating as a container with `data-rating="N"`
 * holding 5 sibling `<a>` or `<span>` elements with classes like `star on`
 * and text content "1 of 5 stars". The text is for screen readers; CSS
 * paints the sprite over it. After sanitisation strips classes and inline
 * styles, the text leaks as visible "1 of 5 stars2 of 5 stars[ 3 of 5
 * stars ]4 of 5 stars5 of 5 stars" garbage.
 *
 * Detection: any element with a `data-rating` attribute (or `data-stars`)
 * whose value parses as 0-5, AND that contains text matching the "N of 5
 * stars" pattern. Both conditions must hold to avoid false positives.
 *
 * Replacement: the container's children are replaced by a `<span
 * class="dx-rating-stars">` holding two child spans (filled / empty) so
 * the web app's CSS can colour them. Runs on the clone before sanitisation,
 * so `data-rating` is available; the `dx-*` classes survive sanitisation.
 */
function substituteStarRatings(root: Element | DocumentFragment): void {
  const STARS_TEXT_RE = /\d+\s+of\s+5\s+stars/i;
  const candidates = (root as Element).querySelectorAll<HTMLElement>(
    '[data-rating], [data-stars]',
  );
  for (const el of Array.from(candidates)) {
    const raw = el.getAttribute('data-rating') ?? el.getAttribute('data-stars') ?? '';
    const rating = parseFloat(raw);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) continue;
    // Require the "N of 5 stars" text inside — confirms this is the sprite
    // widget and not some other use of data-rating (e.g. an analytics tag).
    if (!STARS_TEXT_RE.test(el.textContent ?? '')) continue;
    const filled = Math.round(rating);
    const empty = 5 - filled;
    while (el.firstChild) el.removeChild(el.firstChild);
    const wrap = el.ownerDocument!.createElement('span');
    wrap.className = 'dx-rating-stars';
    const filledSpan = el.ownerDocument!.createElement('span');
    filledSpan.className = 'dx-rating-filled';
    filledSpan.textContent = '★'.repeat(filled);
    const emptySpan = el.ownerDocument!.createElement('span');
    emptySpan.className = 'dx-rating-empty';
    emptySpan.textContent = '☆'.repeat(empty);
    wrap.appendChild(filledSpan);
    wrap.appendChild(emptySpan);
    el.appendChild(wrap);
  }
}

// Elements that render visible content on their own without text descendants.
// Used by collapseEmpty to decide which elements survive the post-sanitisation
// emptiness check.
const VISIBLE_LEAF_TAGS = new Set(['img', 'picture', 'video', 'svg', 'canvas', 'iframe', 'hr', 'input', 'br']);

function hasVisibleContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').trim().length > 0;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  if (VISIBLE_LEAF_TAGS.has((node as Element).tagName.toLowerCase())) return true;
  for (const child of Array.from(node.childNodes)) {
    if (hasVisibleContent(child)) return true;
  }
  return false;
}

/**
 * Remove allowed elements whose subtree contains no visible content. Walks
 * bottom-up so leaves collapse first and their now-empty parents collapse on
 * the next visit. Catches font-awesome `<i>` empties left after class strip,
 * unwrapped custom-element shells, and Angular template wrappers that hold
 * only whitespace text. Preserves anything with text or visible-leaf media.
 *
 * Treats <svg> subtrees as opaque: <path>/<use>/<g> etc. have no text and
 * aren't in VISIBLE_LEAF_TAGS, so naive recursion would strip them and leave
 * empty <svg> shells (e.g. Goodreads's <use href="#...">-based rating stars).
 * If the <svg> survived sanitisation, keep its children.
 */
function collapseEmpty(root: Element): void {
  const walk = (el: Element): void => {
    if (el.tagName.toLowerCase() === 'svg') return;
    Array.from(el.children).forEach(walk);
    if (!hasVisibleContent(el)) el.remove();
  };
  Array.from(root.children).forEach(walk);
}

/**
 * De-duplicate `<img>` elements that share the same media within a tight
 * neighbourhood. Source pages frequently render 2–3 copies of the same image
 * for blur-up loading (Reddit's `cf.preview.redd.it` preview + main img +
 * lightbox-source img), `<picture>` with explicit `<source>` siblings (when
 * sanitisation strips `<picture>`/`<source>` wrappers), or AMP fallback twins.
 *
 * Strategy: group `<img>`s by a stable key derived from (a) the URL's last
 * path segment + final query token, falling back to (b) the alt text. Within
 * a single shared ancestor 3 levels up, drop all but the first non-empty-alt
 * (or first when none have alt). Conservative — won't dedupe across distant
 * regions like multiple comments in a thread that legitimately share an avatar.
 */
function dedupAdjacentImages(root: Element): void {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length < 2) return;

  // Key priority — a shared SOURCE URL is the strongest "same image" signal and is
  // independent of alt text, so it comes FIRST. This catches Reddit, which renders
  // the post image twice with the SAME src but different alt (one alt="", one
  // alt="r/... - <title>"); alt-first keying gave them different keys and left the
  // duplicate. `data-dx-src` (the real URL preserved when images are inlined) is
  // preferred, but note dedup runs BEFORE inlining, so the plain http(s) `src` is
  // usually what's present here — both are handled via urlStem. Then alt-text (for
  // blur-preview + main + lightbox triplets that share alt but not URL), then a
  // byte-identical data: src.
  const urlStem = (u: string): string | null => {
    // Pull the last path segment minus any extension/query for a stable id.
    // "preview.redd.it/this-car-...jpeg?width=640" → "this-car-...".
    const m = u.match(/([^/?#]+?)(?:\.[a-z]{2,5})?(?:\?|#|$)/i);
    return m && m[1].length > 8 ? m[1].toLowerCase() : null;
  };
  // Each image gets up to TWO keys — a URL key and an alt key — and two images
  // are the same picture if they share EITHER. Reddit needs both: it renders the
  // post image twice with (a) the SAME src but different alt, AND on other posts
  // (b) DIFFERENT srcs (…-v0-….jpeg vs …hash.jpeg) but the SAME descriptive alt.
  // A single key can't catch both; the union below does.
  const keysOf = (img: Element): string[] => {
    const keys: string[] = [];
    const dxSrc = (img.getAttribute('data-dx-src') ?? '').trim();
    const src = img.getAttribute('src') ?? '';
    const urlForKey = dxSrc || (src.startsWith('data:') ? '' : src);
    if (urlForKey) {
      const stem = urlStem(urlForKey);
      keys.push(`url:${stem ?? urlForKey.toLowerCase()}`);
    } else if (src.startsWith('data:') && src.length > 200) {
      // Byte-identical inlined data: URIs = unambiguously the same image.
      keys.push(`data:${src.slice(0, 200)}`);
    }
    const alt = (img.getAttribute('alt') ?? '').trim();
    // A descriptive alt is a reliable same-image key; short/blank alts (""/"image")
    // are not (many distinct images share them), so require > 10 chars.
    if (alt.length > 10) keys.push(`alt:${alt.slice(0, 80).toLowerCase()}`);
    return keys;
  };

  // Union images that share ANY key into groups, via union-find. `parent` maps
  // each img to a representative; two imgs are unioned when they share a key.
  const parent = new Map<Element, Element>();
  const find = (x: Element): Element => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path-compress.
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: Element, b: Element) => { parent.set(find(a), find(b)); };

  const firstImgForKey = new Map<string, Element>();
  imgs.forEach(img => {
    const keys = keysOf(img);
    if (keys.length === 0) return;
    if (!parent.has(img)) parent.set(img, img);
    for (const k of keys) {
      const prev = firstImgForKey.get(k);
      if (prev) union(prev, img);
      else firstImgForKey.set(k, img);
    }
  });
  // Collect each union-find set into a group.
  const groups = new Map<Element, Element[]>();
  for (const img of parent.keys()) {
    const root = find(img);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(img);
  }

  // Two elements share an ancestor within N levels iff the closer-to-root one
  // is at most 2N levels above the shared ancestor.
  const sharesAncestorWithin = (a: Element, b: Element, maxDepth: number): boolean => {
    const ancestorsA = new Set<Element>();
    let cur: Element | null = a;
    for (let i = 0; i < maxDepth && cur; i++) { ancestorsA.add(cur); cur = cur.parentElement; }
    cur = b;
    for (let i = 0; i < maxDepth && cur; i++) {
      if (ancestorsA.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  };

  let removed = 0;
  groups.forEach(group => {
    if (group.length < 2) return;
    // Cluster group members by ancestor-proximity. Greedy: walk through the
    // group, assigning each img to the first existing cluster it shares an
    // ancestor with, or starting a new cluster.
    const clusters: Element[][] = [];
    for (const img of group) {
      const cluster = clusters.find(c => sharesAncestorWithin(c[0], img, 6));
      if (cluster) cluster.push(img); else clusters.push([img]);
    }
    clusters.forEach(cluster => {
      if (cluster.length < 2) return;
      const isData = (img: Element) => (img.getAttribute('src') ?? '').startsWith('data:');
      const hasAlt = (img: Element) => (img.getAttribute('alt') ?? '').trim().length > 0;
      // Keeper preference, best first: inlined (data:) AND descriptive alt, then
      // any inlined, then any with an alt, then whatever's first. This keeps the
      // copy that carries a real alt when duplicates differ only by alt text
      // (Reddit's alt="" vs alt="r/... - <title>" pair — drop the alt-less one).
      const keeper = cluster.find(img => isData(img) && hasAlt(img))
        ?? cluster.find(isData)
        ?? cluster.find(hasAlt)
        ?? cluster[0];
      cluster.forEach(img => {
        if (img !== keeper) { img.remove(); removed++; }
      });
    });
  });

  if (removed > 0) {
    log(LL.DEBUG, `Discerned: dedupAdjacentImages removed ${removed} duplicate img(s)`, 'url:', window.location.href);
  }
}

/**
 * Drop the redundant thumbnail rail of an image-carousel / lightbox gallery.
 *
 * Carousel widgets (Splide, Swiper, Slick, PhotoSwipe — used across Valnet /
 * Static-Media sites like How-to Geek, Android Police, MakeUseOf, and many
 * WordPress galleries) render the SAME set of photos twice: a main track of
 * large slides plus a thumbnail strip of small copies. The interactive chrome
 * that hides all-but-one slide is CSS-class-driven, so once sanitisation strips
 * those classes the clip shows every large slide AND every thumbnail — the same
 * N images rendered N-large-then-N-small.
 *
 * `dedupAdjacentImages` deliberately won't merge these: the two tracks sit in
 * separate wrapper elements (>6 ancestor levels apart) so it treats them as
 * distinct regions — the same distance cap that protects avatars repeated
 * across separate comments in a thread.
 *
 * This pass targets the stronger, unambiguous signal instead: images that share
 * BOTH the same non-trivial alt text AND the same URL filename stem are the
 * SAME photo, not two comments' identical avatar (avatars don't carry a
 * per-photo alt). When that exact-duplicate key appears more than once we keep a
 * single copy and drop the rest, regardless of distance. The dropped copies'
 * now-empty carousel wrappers are pruned by the collapseEmpty pass that follows.
 *
 * Keeper = the copy the user actually SAW: carousels ship up to three <img>s per
 * photo (a visible main slide, a hidden retina-source duplicate that renders at
 * 0×0, and a small thumbnail). Rank by the intrinsic width ATTRIBUTE — the main
 * slide (e.g. 1500) is always wider than its thumbnail (e.g. 334), and DOM order
 * (main track precedes the thumbnail rail) breaks ties. We deliberately do NOT
 * rank by *rendered* width: a carousel only renders its active slide, so the
 * other main slides sit at 0×0 off-screen — ranking by rendered size would keep
 * their (still-visible) thumbnails instead of the full-size images. The hidden
 * retina-source duplicate (`visibility:hidden`) is a non-issue here: markExcluded
 * removes it from the tree before this pass runs, so it never joins a group.
 */
function dedupGalleryThumbnails(root: Element): void {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length < 4) return; // need at least a 2-image gallery duplicated

  const stemOf = (img: Element): string => {
    const src = img.getAttribute('src') ?? img.getAttribute('data-dx-src') ?? '';
    if (src.startsWith('data:')) return ''; // base64 varies per byte — no stem
    const m = src.match(/([^/?#]+?)(?:\.[a-z]{2,5})?(?:\?|#|$)/i);
    return m && m[1].length > 8 ? m[1].toLowerCase() : '';
  };
  const widthOf = (img: Element): number => {
    const w = parseInt(img.getAttribute('width') ?? '', 10);
    return Number.isFinite(w) ? w : 0;
  };

  // Key requires BOTH a real alt (>10 chars) and a stable filename stem, so it
  // only ever fires on genuinely identical photos — never on avatars (no alt)
  // or same-stem-different-crop hero variants (no shared long alt).
  const groups = new Map<string, Element[]>();
  imgs.forEach(img => {
    const alt = (img.getAttribute('alt') ?? '').trim();
    const stem = stemOf(img);
    if (alt.length <= 10 || !stem) return;
    const key = `${alt.slice(0, 80).toLowerCase()}|${stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(img);
  });

  let removed = 0;
  groups.forEach(group => {
    if (group.length < 2) return;
    // Keep the widest (main slide); DOM order (main track first) breaks ties.
    const keeper = group.reduce((best, img) => (widthOf(img) > widthOf(best) ? img : best), group[0]);
    group.forEach(img => { if (img !== keeper) { img.remove(); removed++; } });
  });

  if (removed > 0) {
    log(LL.DEBUG, `Discerned: dedupGalleryThumbnails removed ${removed} duplicate gallery img(s)`, 'url:', window.location.href);
  }
}

// ── Generic page-chrome text patterns ────────────────────────────────────────
// Exact-text chrome verbs on <a>/<button>: share/save/follow clusters (BBC),
// question toolbars (Stack Overflow), author Follow buttons (Medium). Matched
// against the element's ENTIRE trimmed text, so a prose link containing one of
// these words is never touched. "Show more" is deliberately absent — tweet
// cards carry a legitimate "Show more" anchor.
const CHROME_LINK_TEXT_RE = new RegExp(
  '^(share|save|follow|following|report|reply|copy link|show comments' +
  '|improve this (question|answer)|add a comment|follow this (question|answer).*' +
  '|share a link to this (question|answer)|short permalink.*' +
  '|add as preferred.*|choose .{0,40} as a preferred source.*|add us on google' +
  '|open comment sort options|expand comment search' +
  '|continue this thread.*|continue reading.*|view (all|more) comments.*' +
  '|see more (posts|comments).*|load more comments.*|more replies.*)$', 'i');
// Skip-navigation links ("Skip to content", "Jump to ratings and reviews").
const SKIP_LINK_RE = /^(skip to|jump to)\b/i;
// Headings that UNAMBIGUOUSLY introduce a recirculation module — removed
// structurally (no link-density requirement, since teaser cards mix images
// and non-link text).
const STRONG_RELATED_RE = new RegExp(
  '^(discover more|want to know more\\??|you might also like|recommended for you' +
  '|suggested for you|most (read|popular)|trending now|up next' +
  '|related (articles|stories|posts)|readers also enjoyed' +
  '|more (\\w+ )?stories on \\w.*)$', 'i');
// Weaker headings that also occur in real prose — these additionally require
// the container to be link-dominant before anything is removed.
const RELATED_HEADING_RE = new RegExp(
  '^(discover more|want to know more\\??|related(:| articles| stories| posts| topics)?' +
  '|recommended( for you)?|read (next|more)|more from\\b.*|you might also like' +
  '|readers also enjoyed|more (\\w+ )?stories on \\w.*' +
  '|most (read|popular)|trending( now)?|suggested for you|up next|popular in\\b.*)$', 'i');
// Newsletter signup copy.
const NEWSLETTER_RE =
  /(subscribe to (our|the) newsletter|sign up for (our|the) |never miss the news|directly to your inbox|daily recap of|get our (free )?newsletter)/i;
// "Make us your preferred source" promos (Google preferred-source pitch) that
// render as plain text next to an icon link rather than as a labelled link.
const PREFERRED_SOURCE_RE = /(preferred source of news|add us on google|make .{0,40} your preferred source)/i;

/**
 * Drop page chrome that the landmark stripper can't see: it identifies chrome
 * by TEXT rather than by <nav>/<aside> tags, so it works on the div-soup
 * modules news sites render inline with the article (share/save toolbars,
 * "Discover more" recirculation boxes, newsletter signups, sort menus).
 * Runs inside sanitiseTreeInPlace so every capture path (site-tagger or
 * generic, article/selection/full-page) gets it. Skips tweet-card subtrees —
 * their links are part of the reconstructed tweet.
 */
function removeGenericChrome(root: Element): void {
  const inTweetCard = (el: Element): boolean => !!el.closest('[class*="tweet-card"]');

  // (1) Skip-links + exact-text chrome verbs.
  root.querySelectorAll('a, button').forEach(el => {
    // The tree is detached (isConnected is false everywhere) — use
    // root.contains() to skip only nodes a prior removal already dropped.
    if (!root.contains(el) || inTweetCard(el)) return;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > 60) return;
    const href = el.getAttribute('href') ?? '';
    if (SKIP_LINK_RE.test(text) && (href === '' || href.startsWith('#'))) { el.remove(); return; }
    if (CHROME_LINK_TEXT_RE.test(text)) el.remove();
  });

  // (2) Related-content boxes: a short heading matching RELATED_HEADING_RE
  // whose container is link-dominant (a list of story/category links). Climb
  // conservatively so an article section that merely SAYS "Related:" in prose
  // survives.
  const headingSeeds = Array.from(root.querySelectorAll('*')).filter(el => {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 0 && t.length <= 40 && RELATED_HEADING_RE.test(t) &&
      !Array.from(el.children).some(c => RELATED_HEADING_RE.test((c.textContent ?? '').trim()));
  });
  // Real prose disqualifies a container from removal — a recirculation module
  // holds teaser titles and category links, never a 200-char paragraph.
  const hasLongProse = (el: Element): boolean =>
    Array.from(el.querySelectorAll('p')).some(p => (p.textContent ?? '').trim().length >= 200);

  for (const seed of headingSeeds) {
    if (!root.contains(seed) || inTweetCard(seed)) continue;
    const seedText = (seed.textContent ?? '').replace(/\s+/g, ' ').trim();
    const strong = STRONG_RELATED_RE.test(seedText);
    const seedLen = seedText.length;
    let box: Element | null = null;
    let cursor: Element = seed;
    for (let i = 0; i < 3; i++) {
      const p: Element | null = cursor.parentElement;
      if (!p || p === root) break;
      const total = (p.textContent ?? '').replace(/\s+/g, ' ').length;
      if (total > (strong ? 2500 : 1500)) break; // too big — would eat article content
      if (hasLongProse(p)) break;
      if (strong) {
        // Unambiguous module heading: the enclosing prose-free container IS
        // the module, whatever mix of links/images/teaser text it holds.
        if (p.querySelectorAll('a').length >= 1) box = p;
      } else {
        const linkLen = Array.from(p.querySelectorAll('a'))
          .reduce((n, a) => n + (a.textContent ?? '').replace(/\s+/g, ' ').length, 0);
        const rest = total - seedLen;
        if (rest > 0 && p.querySelectorAll('a').length >= 2 && linkLen / rest >= 0.6) {
          box = p;
        }
      }
      cursor = p;
    }
    if (box) {
      box.remove();
      log(LL.DEBUG, 'Discerned: removeGenericChrome dropped related-content box', 'url:', window.location.href);
    }
  }

  // (3) Newsletter signup blocks: smallest text match, then climb to the
  // enclosing short container.
  const newsletterSeeds = Array.from(root.querySelectorAll('*')).filter(el =>
    NEWSLETTER_RE.test(el.textContent ?? '') &&
    !Array.from(el.children).some(c => NEWSLETTER_RE.test(c.textContent ?? '')));
  for (const seed of newsletterSeeds) {
    if (!root.contains(seed) || seed === root) continue;
    let box: Element = seed;
    for (let i = 0; i < 3; i++) {
      const p = box.parentElement;
      if (!p || p === root || (p.textContent ?? '').length > 500) break;
      box = p;
    }
    box.remove();
    log(LL.DEBUG, 'Discerned: removeGenericChrome dropped newsletter block', 'url:', window.location.href);
  }

  // (3b) "Preferred source" promo strips — text pitch + icon link, not a
  // labelled anchor, so pass (1) can't see them.
  const promoSeeds = Array.from(root.querySelectorAll('*')).filter(el =>
    PREFERRED_SOURCE_RE.test(el.textContent ?? '') &&
    !Array.from(el.children).some(c => PREFERRED_SOURCE_RE.test(c.textContent ?? '')));
  for (const seed of promoSeeds) {
    if (!root.contains(seed) || seed === root) continue;
    let box: Element = seed;
    for (let i = 0; i < 2; i++) {
      const p = box.parentElement;
      if (!p || p === root || (p.textContent ?? '').replace(/\s+/g, ' ').length > 200) break;
      box = p;
    }
    box.remove();
  }

  // (4) Interactive ARIA chrome that has no meaning in a static clip: dropdown
  // menus, sort listboxes, tab strips, native selects.
  root.querySelectorAll('select, [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"]').forEach(el => {
    if (inTweetCard(el)) return;
    el.remove();
  });

  // (5) Image-viewer affordance captions ("Press enter or click to view image
  // in full size") — Medium/CMS lightbox hint text that sits above every
  // figure. Exact-ish leaf text match.
  const VIEWER_HINT_RE = /^(press enter or click to view|click to (view|enlarge|expand)|tap to (view|expand)|view (image|full size))/i;
  root.querySelectorAll('span, div, p, figcaption').forEach(el => {
    if (el.querySelector('img, div, span, p')) return;
    if (VIEWER_HINT_RE.test((el.textContent ?? '').trim())) el.remove();
  });

  // (6) De-duplicate repeated engagement rows. Medium renders the SAME
  // clap/comment counts three times (sticky top bar + inline bar + footer),
  // and each survived as a dx-stats row → "79 4" appears three times. Keep the
  // first occurrence of each distinct non-empty dx-stats text; drop the rest.
  const seenStats = new Set<string>();
  root.querySelectorAll('.dx-stats').forEach(el => {
    const key = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (key.length === 0) { el.remove(); return; }
    if (seenStats.has(key)) { el.remove(); return; }
    seenStats.add(key);
  });

  // (7) Tag / category link lists (Breitbart's trailing category strip, WP tag
  // clouds): a <ul>/<ol>/<nav> that is almost entirely short category links —
  // ≥4 links, each short, links make up nearly all the text, and no real prose
  // paragraph inside. These are navigation, not article content, and the cast
  // has no CSS to hide them (the clip does), so they leak as a stacked link
  // list. Conservative: a real in-article list has longer items or prose.
  root.querySelectorAll('ul, ol, nav').forEach(el => {
    if (!root.contains(el) || inTweetCard(el)) return;
    const anchors = Array.from(el.querySelectorAll('a'));
    if (anchors.length < 4) return;
    const anchorText = anchors
      .map(a => (a.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (anchorText.length < 4) return;
    // Every link is short (a category/tag label, never a teaser sentence).
    if (anchorText.some(t => t.length > 40)) return;
    // Links dominate the container's text (≥80%) — nothing but the link labels
    // (list-item whitespace / bullets keep the ratio just under 1).
    const totalLen = (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    const linkLen = anchorText.reduce((n, t) => n + t.length, 0);
    if (totalLen === 0 || linkLen / totalLen < 0.8) return;
    // No real prose paragraph (a references/footnotes list can carry sentences).
    if (Array.from(el.querySelectorAll('p, li')).some(n => (n.textContent ?? '').trim().length > 80)) return;
    el.remove();
    log(LL.DEBUG, 'Discerned: removeGenericChrome dropped tag/category link list', 'url:', window.location.href);
  });
}

/**
 * Insert a space text node between the element children of every container the
 * live page laid out with flex/grid (FLEXSEP_MARKER, stamped by
 * annotateLiveImageSizes). Without this, sanitisation collapses visually
 * separated flex items into adjacent inline boxes whose text runs together:
 * "399M views21 years ago", "Imran Rahman-JonesTechnology reporter".
 */
function applyFlexSeparation(root: Element): void {
  const targets = Array.from(root.querySelectorAll(`[${FLEXSEP_MARKER}]`));
  if (root.hasAttribute?.(FLEXSEP_MARKER)) targets.push(root);
  for (const el of targets) {
    el.removeAttribute(FLEXSEP_MARKER);
    const kids = Array.from(el.children);
    for (let i = 0; i < kids.length - 1; i++) {
      const left = kids[i].textContent ?? '';
      const right = kids[i + 1].textContent ?? '';
      if (left.length === 0 || right.length === 0) continue;
      if (/\s$/.test(left) || /^\s/.test(right)) continue;
      el.insertBefore(document.createTextNode(' '), kids[i + 1]);
    }
  }
}

function sanitiseTreeInPlace(root: Element, stripStyles = false) {
  // Drop dangerous elements outright before walking. <foreignObject> can host
  // arbitrary HTML inside <svg>; drop it explicitly even though it's not in the
  // SVG whitelist (the walk-unwrap below would otherwise leak its children).
  root.querySelectorAll('script, style, iframe, object, embed, link, meta, noscript, foreignObject').forEach(el => el.remove());

  // Space out former flex/grid children BEFORE the attribute-stripping walk
  // consumes the live-layout markers, then drop text-identified page chrome.
  applyFlexSeparation(root);
  removeGenericChrome(root);

  const walk = (node: Node) => {
    Array.from(node.childNodes).forEach(walk);
    // Comments never belong in a stored clip — they bloat the HTML and can
    // carry source-page junk (build markers, ad-slot annotations).
    if (node.nodeType === Node.COMMENT_NODE) { (node as Comment).remove(); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    sanitiseElement(node as Element, stripStyles);
  };
  Array.from(root.childNodes).forEach(walk);

  // Drop the redundant small-thumbnail rail of a carousel/lightbox gallery
  // (main slides + duplicate thumbnail strip) — the same photo rendered twice.
  // Runs before dedupAdjacentImages: it uses a stronger alt+stem key with no
  // distance cap, whereas dedupAdjacentImages won't cross the two tracks.
  dedupGalleryThumbnails(root);

  // De-duplicate <img>s that the source rendered as multiple copies of the
  // same media (Reddit's blur-preview + main + lightbox-source pattern, news
  // sites' AMP <amp-img fallback> + <img> twins, <picture> with explicit
  // <source> + <img> when the sanitiser strips <picture>/<source> wrappers).
  dedupAdjacentImages(root);

  // Collapse elements whose subtree has no visible content. Runs after the
  // sanitisation walk so unwrapping/attribute-stripping have already produced
  // the empties (e.g. <i> with stripped fa-* classes, <div> wrappers from
  // unwrapped custom elements). Before the SVG cap so empty SVG wrappers
  // don't waste cap budget.
  collapseEmpty(root);

  // Cap inline SVGs per article — pathological pages (icon galleries) could
  // otherwise bloat the stored Nostr event.
  const svgs = root.querySelectorAll('svg');
  if (svgs.length > MAX_SVGS_PER_ARTICLE) {
    log(LL.DEBUG, `Discerned: sanitiseTreeInPlace dropping ${svgs.length - MAX_SVGS_PER_ARTICLE} of ${svgs.length} SVGs (cap=${MAX_SVGS_PER_ARTICLE})`, 'url:', window.location.href);
    for (let i = MAX_SVGS_PER_ARTICLE; i < svgs.length; i++) svgs[i].remove();
  }
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

const INLINE_CONCURRENCY = 16;

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

// Max image URLs collected for a generic cast. Tweet captures (Tier 0) set
// their own uncapped list — a tweet + quoted tweet can carry up to 8 photos.
const MAX_CAST_IMAGE_URLS = 8;

// Skip imgs whose annotated width/height is below this — avatars render at
// ~44px, icons at 16–32px, real content images at hundreds of px. Only applied
// when a size attribute is present (Tier-2 Readability output has none).
const MIN_CAST_IMAGE_PX = 100;

// Resolve an <img>'s real URL. Many news sites (CNN, etc.) lazy-load with
// data-src; prefer it over a placeholder 1×1 src. Also check data-lazy-src
// used by some WordPress themes. Relative srcs resolve against the live page.
function resolveImgSrc(img: HTMLImageElement, baseUrl: string): string | null {
  const raw =
    img.getAttribute('data-src') ||
    img.getAttribute('data-lazy-src') ||
    img.getAttribute('src');
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

// Collect the remote URLs of cast-worthy content images, in document order:
// skips avatars/byline imagery (dx-*/tweet-* markers survive sanitisation),
// icon-sized imgs, and non-http(s) srcs; dedupes; caps at MAX_CAST_IMAGE_URLS.
// Read-only — must not mutate the tree, so the inlined HTML output of
// inlineAllImages is unaffected by collection.
function collectCastImageUrls(imgs: HTMLImageElement[], baseUrl: string): string[] {
  const urls: string[] = [];
  for (const img of imgs) {
    if (urls.length >= MAX_CAST_IMAGE_URLS) break;
    if (img.matches('.dx-avatar, .tweet-avatar')) continue;
    if (img.closest('.dx-header, .dx-byline, .tweet-header')) continue;
    const w = parseInt(img.getAttribute('width') ?? '', 10);
    const h = parseInt(img.getAttribute('height') ?? '', 10);
    if ((!Number.isNaN(w) && w < MIN_CAST_IMAGE_PX) ||
        (!Number.isNaN(h) && h < MIN_CAST_IMAGE_PX)) continue;
    const abs = resolveImgSrc(img, baseUrl);
    if (!abs || !/^https?:/i.test(abs)) continue;
    if (!urls.includes(abs)) urls.push(abs);
  }
  return urls;
}

async function inlineAllImages(html: string): Promise<{ html: string; imageUrls: string[] }> {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return { html, imageUrls: [] };

  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length === 0) return { html, imageUrls: [] };

  // Resolve relative srcs against the live page (not the synthetic doc).
  const baseUrl = window.location.href;

  // Collect cast-worthy remote URLs BEFORE inlining swaps srcs to data: URIs.
  const imageUrls = collectCastImageUrls(imgs, baseUrl);

  const queue = imgs.slice();

  const worker = async () => {
    while (queue.length) {
      const img = queue.shift();
      if (!img) break;
      const abs = resolveImgSrc(img, baseUrl);
      if (!abs) continue;
      // Preserve the original http(s) URL before we overwrite src with a data:
      // URI. The private clip renders the inline base64 (src); the public
      // long-form (kind 30023) converts THIS attribute back into a real
      // ![](url) so images render inline for any Nostr client (data: URIs are
      // too large to publish). See html-to-markdown.ts.
      if (/^https?:/i.test(abs)) img.setAttribute('data-dx-src', abs);
      const inlined = await inlineImage(abs);
      img.setAttribute('src', inlined);
      // Remove lazy-load attributes so the stored HTML is self-contained.
      img.removeAttribute('data-src');
      img.removeAttribute('data-lazy-src');
    }
  };

  const workers = Array.from({ length: Math.min(INLINE_CONCURRENCY, imgs.length) }, worker);
  await Promise.all(workers);
  return { html: root.innerHTML, imageUrls };
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
