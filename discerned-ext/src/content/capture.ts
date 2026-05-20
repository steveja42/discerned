// Role: Content Script — capture layer
// Description: Four-format clip extractor (selection, article, full-page,
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
  switch (format) {
    case 'selection':           return extractSelection();
    case 'article':             return extractArticle(opts);
    case 'full-page':           return extractFullPage(opts);
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

async function extractSelection(): Promise<Capture> {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.toString().trim().length === 0) {
    return extractBookmark();
  }

  const range = selection.getRangeAt(0);
  const cleanup = markExcluded(document.body);
  // Annotate <img>s under the range's common ancestor before cloneContents
  // runs inside wrapFragmentBoundaries, so the cloned fragment carries
  // rendered width/height attributes. Over-annotating outside the range is
  // harmless — only images that end up in the fragment matter, and the
  // sizeCleanup runs synchronously.
  const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  const sizeCleanup = ancestor ? annotateLiveImageSizes(ancestor) : () => {};
  const fragment = wrapFragmentBoundaries(range);
  sizeCleanup();
  cleanup();
  removeMarked(fragment);
  stripSizeMarkers(fragment);
  // Twitter GIFs and videos are <video poster="..."> — convert to <img> so they
  // survive sanitisation (which drops <video> as a non-allowed tag).
  substituteVideosWithPosters(fragment);
  const sanitized = sanitizeFragment(fragment);
  const context = extractContext(range);
  const inlined = await inlineAllImages(sanitized);

  return {
    ...baseFields(),
    format: 'selection',
    selectionText: inlined,
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

// ── Twitter / X extractor ────────────────────────────────────────────────────

/**
 * Build a clean tweet card from Twitter's live DOM using data-testid selectors,
 * which are stable across Twitter's obfuscated class names. Returns null if any
 * required element is missing so the caller can fall through to generic capture.
 */
/** Extract name, badges, text, photos, and video poster from a tweet container element. */
async function extractTweetBlock(root: Element) {
  const userNameEl = root.querySelector<HTMLElement>('[data-testid="User-Name"]');
  const displayName = userNameEl?.querySelector<HTMLElement>('span > span')?.textContent?.trim() ?? '';

  // Handle: prefer an <a href="/..."> inside User-Name (outer tweet), fall back to
  // the first @-prefixed span anywhere in the root (quoted tweet's handle is outside User-Name).
  const handleFromLink = userNameEl?.querySelector<HTMLAnchorElement>('a[href^="/"]')
    ?.getAttribute('href')?.replace(/^\//, '') ?? '';
  const handleFromSpan = !handleFromLink
    ? Array.from(root.querySelectorAll<HTMLElement>('span'))
        .find(s => s.textContent?.trim().startsWith('@'))
        ?.textContent?.trim().replace(/^@/, '') ?? ''
    : '';
  const handle = handleFromLink || handleFromSpan;

  // Relative time shown in quoted tweets (e.g. "22h")
  const quoteTimeEl = root.querySelector<HTMLElement>('time[datetime]');
  const quoteTime = quoteTimeEl?.textContent?.trim() ?? '';
  const nameLinkEl = userNameEl?.querySelector<HTMLElement>('a[href^="/"]');
  const badgeEls = nameLinkEl
    ? Array.from(nameLinkEl.querySelectorAll<HTMLElement>('img, svg[data-testid="icon-verified"]'))
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
  const tweetTextEl = root.querySelector<HTMLElement>('[data-testid="tweetText"]');
  const sanitisedText = sanitizeHtmlString(tweetTextEl?.innerHTML ?? '');
  const plainText = tweetTextEl?.textContent?.trim() ?? '';
  // Videos: collect ALL video players — tweets can have 2 side-by-side videos.
  // For each tweetPhoto container with a videoPlayer, capture poster, duration, and aspect ratio.
  const videoInfos: VideoInfo[] = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="tweetPhoto"]'))
    .filter(c => c.querySelector('[data-testid="videoPlayer"]'))
    .flatMap(container => {
      const videoEl = container.querySelector<HTMLVideoElement>('[data-testid="videoPlayer"] video[poster]');
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

  // Photo srcs: only from tweetPhoto containers that do NOT contain a video player.
  const photoSrcs = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="tweetPhoto"]'))
    .filter(container => !container.querySelector('[data-testid="videoPlayer"]'))
    .flatMap(container => Array.from(container.querySelectorAll<HTMLImageElement>('img')))
    .map(img => img.src).filter(isSafeImageSrc);

  return { displayName, handle, quoteTime, badgesHtml: badgeHtmlParts.join(''), sanitisedText, plainText, photoSrcs, videoInfos };
}

type VideoInfo = { poster: string; duration: string | null; aspectPct: number | null };

function buildSingleVideoHtml(poster: string, duration: string | null, aspectPct: number | null, href: string): string {
  const maxWidth = aspectPct && aspectPct > 100
    ? `${Math.round(100 / (aspectPct / 100))}%`
    : '100%';
  const safeDuration = duration
    ? duration.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : null;
  return `<a class="tweet-video" href="${href}" target="_blank" rel="noopener noreferrer" style="max-width:${maxWidth}">
  <img src="${poster}" alt="Video thumbnail" class="tweet-video-poster">
  <div class="tweet-video-play" aria-label="Play video">
    <svg viewBox="0 0 24 24" width="48" height="48"><path d="M8 5v14l11-7z"/></svg>
  </div>${safeDuration ? `<span class="tweet-video-duration">${safeDuration}</span>` : ''}
</a>`;
}

function buildVideoHtml(inlinedVideos: Array<{ poster: string; duration: string | null; aspectPct: number | null }>, href: string): string {
  if (inlinedVideos.length === 0) return '';
  const items = inlinedVideos.map(v => buildSingleVideoHtml(v.poster, v.duration, v.aspectPct, href));
  if (items.length === 1) return items[0];
  // Multiple videos: render in a grid row matching how X shows side-by-side videos.
  return `<div class="tweet-video-grid">${items.join('')}</div>`;
}

async function extractTweet(base: Pick<Capture, 'id' | 'url' | 'title' | 'timestamp'>): Promise<Capture | null> {
  const article = document.querySelector('article[data-testid="tweet"]') ??
                  document.querySelector('article');
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
  const quoteContainer = article.querySelector<HTMLElement>('[role="link"]:has([data-testid="User-Name"])');
  const isQuote = !!(quoteContainer?.querySelector('[data-testid="tweetText"]'));
  let quotedHtml = '';

  if (isQuote && quoteContainer) {
    log(LL.DEBUG, `Discerned: quote tweet detected — "${quoteContainer.querySelector('[data-testid="tweetText"]')?.textContent?.trim().slice(0, 60)}"`, 'url:', base.url);
    const qb = await extractTweetBlock(quoteContainer);
    const qAvatarImg = quoteContainer.querySelector<HTMLImageElement>('[data-testid="Tweet-User-Avatar"] img');
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
    const qPhotosHtml = qPhotos.filter(Boolean).map(src =>
      `<div class="tweet-photo"><img src="${src}" alt="Image"></div>`).join('');
    const qInlinedVideoInfos = qb.videoInfos
      .map((v, i) => ({ poster: qInlinedVideoPosters[i] || v.poster, duration: v.duration, aspectPct: v.aspectPct }))
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
  const tweetPhotoSrcs = Array.from(article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img'))
    .filter(img => !quoteContainer?.contains(img))
    .map(img => img.src).filter(isSafeImageSrc);

  // Date/time — grab the <time> element and its parent link href
  const timeEl = article.querySelector<HTMLTimeElement>('time[datetime]');
  const dateText = timeEl?.textContent?.trim() ?? '';
  const dateHref = timeEl?.closest('a')?.getAttribute('href') ?? '';

  // Engagement stats — lift each button's SVG icon + count text directly from the DOM.
  // We strip Twitter's obfuscated class names (useless without their stylesheet) but keep
  // viewBox and path data so the icons render correctly with our own sizing CSS.
  const STAT_TESTIDS = ['reply', 'retweet', 'like', 'bookmark'] as const;
  const statItems: Array<{ svg: string; count: string; label: string }> = [];
  for (const testId of STAT_TESTIDS) {
    const btn = article.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!btn) continue;
    const svgEl = btn.querySelector('svg');
    if (!svgEl) continue;
    const svgClone = svgEl.cloneNode(true) as SVGElement;
    svgClone.removeAttribute('class');
    svgClone.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));
    const countEl = btn.querySelector('[data-testid="app-text-transition-container"] span span');
    statItems.push({
      svg: svgClone.outerHTML,
      count: countEl?.textContent?.trim() ?? '',
      label: btn.getAttribute('aria-label') ?? testId,
    });
  }

  // Avatar
  const avatarImg = article.querySelector<HTMLImageElement>('[data-testid="Tweet-User-Avatar"] img') ??
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
    .map((v, i) => ({ poster: inlinedVideoPosters[i] || v.poster, duration: v.duration, aspectPct: v.aspectPct }))
    .filter(v => v.poster);
  const videoHtml = buildVideoHtml(inlinedVideoInfos, base.url);

  const photosHtml = [
    ...inlinedPhotos.filter(Boolean).map(src => `<div class="tweet-photo"><img src="${src}" alt="Image"></div>`),
  ].join('');

  // Footer: date link + stat buttons (SVG icon + count lifted from Twitter's DOM)
  const safeDate = dateText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const safeDateHref = dateHref.startsWith('/') ? `https://x.com${dateHref}` : '';
  const dateHtml = safeDate
    ? (safeDateHref
        ? `<a class="tweet-date" href="${safeDateHref}">${safeDate}</a>`
        : `<span class="tweet-date">${safeDate}</span>`)
    : '';
  const statsHtml = statItems.map(({ svg, count, label }) =>
    `<span class="tweet-stat" aria-label="${label.replace(/"/g,'&quot;')}">${svg}${count ? `<span class="tweet-stat-count">${count}</span>` : ''}</span>`
  ).join('');
  const footerHtml = (dateHtml || statsHtml)
    ? `<div class="tweet-footer">${dateHtml}${statsHtml ? `<span class="tweet-stats">${statsHtml}</span>` : ''}</div>`
    : '';

  const bodyHtml = `<div class="tweet-card">
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

  log(LL.NORMAL, `Discerned: tweet captured — name="${displayName}" handle="@${handle}" photos=${inlinedPhotos.filter(Boolean).length} videos=${inlinedVideoInfos.length} repost=${!!reposterHtml} quoted=${!!quotedHtml} stats=${statItems.length}`, 'url:', base.url);

  // X appends ` https://t.co/… " / X` or just `" / X` to the page title.
  const tweetTitle = base.title
    .replace(/\s+https:\/\/t\.co\/\S+/i, '')  // strip trailing t.co URL
    .replace(/["\s]+\/\s*X\s*$/i, '')          // strip closing `" / X`
    .trim() || base.title;

  return {
    ...base,
    title: tweetTitle,
    format: 'article',
    bodyHtml,
    bodyText: `${displayName} @${handle}\n\n${outerBlock.plainText}`,
    thumbnail: null,
  };
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
  if (el.querySelector(':scope > header, :scope > footer')) return true;
  const directSections = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'section');
  if (directSections.length >= 3) return true;
  return false;
}

function findArticleElement(smartDetection: boolean): Element | null {
  for (const sel of ARTICLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el || (el.textContent ?? '').trim().length < ARTICLE_MIN_CHARS) continue;
    if (smartDetection && looksLikeContainer(el)) {
      log(LL.NORMAL, `Discerned: skipping <${el.tagName.toLowerCase()}> (looks like container) — falling to Readability`, 'url:', window.location.href);
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
  const all = Array.from(document.body.querySelectorAll('*'));
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
  log(LL.NORMAL, `Discerned: layout-finder picked <${best.el.tagName.toLowerCase()}> textLen=${best.textLen} ${Math.round(best.width)}×${Math.round(best.height)}`, 'url:', window.location.href);
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

  log(LL.NORMAL, `Discerned: layout-finder expanded to feed parent — ${siblings.length} siblings, ${parentText} chars vs ${elText} alone`, 'url:', window.location.href);
  return parent;
}

async function extractArticle(opts: CaptureOptions): Promise<Capture> {
  const base = baseFields();
  log(LL.DEBUG, `Discerned: extractArticle — smartArticleDetection=${opts.smartArticleDetection} stripInlineStyles=${opts.stripInlineStyles}`, 'url:', base.url);

  // Apply per-site live-DOM tagger (if registered for this hostname) so the
  // captured HTML carries dx-* markers across sanitisation regardless of
  // which extraction tier wins below. When a site tagger runs, the generic
  // semantic-structure pass downstream is skipped so it doesn't re-tag the
  // same elements with conflicting markers.
  siteTaggerActive = applySiteTagger();

  // Tier 0: Twitter/X — extract clean tweet card from data-testid selectors.
  if (/^https?:\/\/(www\.)?(twitter|x)\.com\//i.test(window.location.href)) {
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
    log(LL.NORMAL, `Discerned: article captured via semantic element <${articleEl.tagName.toLowerCase()}>`, 'url:', base.url);
    const cleanup = markExcluded(document.body);
    const sizeCleanup = annotateLiveImageSizes(articleEl);
    const clone = articleEl.cloneNode(true) as Element;
    sizeCleanup();
    cleanup();
    clone.querySelector('discerned-overlay')?.remove();
    removeMarked(clone);
    stripSizeMarkers(clone);
    substituteVideosWithPosters(clone);
    tagSemanticStructure(clone);
    const imgsBefore = clone.querySelectorAll('img').length;
    sanitiseTreeInPlace(clone as HTMLElement, opts.stripInlineStyles);
    const imgsAfter = clone.querySelectorAll('img[style]').length;
    log(LL.DEBUG, `Discerned: sanitiseTreeInPlace done — ${imgsBefore} imgs, ${imgsAfter} with remaining inline style, stripInlineStyles=${opts.stripInlineStyles}`, 'url:', base.url);
    log(LL.TRACE, `Discerned: sanitised bodyHtml (first 2000 chars): ${clone.innerHTML.slice(0, 2000)}`, 'url:', base.url);
    const inlined = await inlineAllImages(clone.innerHTML.trim());
    log(LL.NORMAL, `Discerned: article imgs after inlining — ${(inlined.match(/<img[^>]*>/gi) ?? []).length} total`, 'url:', base.url);
    return {
      ...base,
      format: 'article',
      bodyHtml: inlined,
      bodyText: clone.textContent?.trim() ?? '',
      thumbnail: inlinedThumbnail,
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
    log(LL.NORMAL, `Discerned: article captured via layout finder <${layoutEl.tagName.toLowerCase()}>`, 'url:', base.url);
    const cleanup = markExcluded(document.body);
    const sizeCleanup = annotateLiveImageSizes(layoutEl);
    // A tagger-supplied root is already the intended scope — don't widen it.
    const expanded = siteTaggerRoot ? layoutEl : maybeExpandToFeed(layoutEl);
    const clone = expanded.cloneNode(true) as Element;
    sizeCleanup();
    cleanup();
    clone.querySelector('discerned-overlay')?.remove();
    removeMarked(clone);
    stripSizeMarkers(clone);
    substituteVideosWithPosters(clone);
    tagSemanticStructure(clone);
    sanitiseTreeInPlace(clone as HTMLElement, opts.stripInlineStyles);
    const inlined = await inlineAllImages(clone.innerHTML.trim());
    log(LL.NORMAL, `Discerned: layout-finder imgs after inlining — ${(inlined.match(/<img[^>]*>/gi) ?? []).length} total`, 'url:', base.url);
    return {
      ...base,
      format: 'article',
      bodyHtml: inlined,
      bodyText: clone.textContent?.trim() ?? '',
      thumbnail: inlinedThumbnail,
    };
  }

  // Tier 2: Readability — for pages without semantic article markup.
  const parsed = parseReadability();
  if (parsed) {
    log(LL.NORMAL, 'Discerned: article captured via Readability', 'url:', base.url);
    let sanitized = sanitizeHtmlString(parsed.content);
    if (!/<img[\s>]/i.test(sanitized) && thumbnailUrl && isSafeImageSrc(thumbnailUrl)) {
      const alt = (parsed.title || base.title).replace(/"/g, '&quot;');
      sanitized = `<figure><img src="${thumbnailUrl}" alt="${alt}"></figure>\n${sanitized}`;
    }
    const inlined = await inlineAllImages(sanitized);
    log(LL.NORMAL, `Discerned: article imgs after inlining — ${(inlined.match(/<img[^>]*>/gi) ?? []).length} total`, 'url:', base.url);
    return {
      ...base,
      format: 'article',
      title: parsed.title || base.title,
      bodyHtml: inlined,
      bodyText: parsed.textContent.trim(),
      thumbnail: inlinedThumbnail,
    };
  }

  // Tier 3: full body — last resort.
  log(LL.WARN, 'Discerned: article falling back to full body', 'url:', base.url);
  const bodyClone = cloneBodyClean();
  stripSizeMarkers(bodyClone);
  substituteVideosWithPosters(bodyClone);
  tagSemanticStructure(bodyClone);
  sanitiseTreeInPlace(bodyClone);
  const inlined = await inlineAllImages(bodyClone.innerHTML.trim());
  return {
    ...base,
    format: 'article',
    bodyHtml: inlined,
    bodyText: bodyClone.textContent?.trim() ?? '',
    thumbnail: inlinedThumbnail,
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
    const bodyClone = document.body.cloneNode(true) as HTMLElement;
    sizeCleanup();
    stripSizeMarkers(bodyClone);
    bodyClone.querySelector('discerned-overlay')?.remove();
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
  // Clone the body only — using outerHTML (which includes <html>/<head>) causes
  // DOMParser to restructure the document in ways that leave <script> content as
  // orphaned text nodes that querySelectorAll('script') can't reach.
  const bodyClone = cloneBodyClean();
  substituteVideosWithPosters(bodyClone);
  sanitiseTreeInPlace(bodyClone, opts.stripInlineStyles);
  const inlined = await inlineAllImages(bodyClone.innerHTML.trim());
  return {
    ...baseFields(),
    format: 'full-page',
    bodyHtml: inlined,
    bodyText: bodyClone.textContent?.trim() ?? '',
    thumbnail: getPageThumbnail(),
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
  root.querySelectorAll<HTMLElement>('*').forEach(el => {
    if (el.tagName.toLowerCase() === 'discerned-overlay') return;
    const s = window.getComputedStyle(el);
    if (s.position === 'fixed' || s.position === 'sticky' ||
        s.display === 'none' || s.visibility === 'hidden') {
      el.setAttribute(EXCL_MARKER, '1');
    }
  });
  return () => root.querySelectorAll(`[${EXCL_MARKER}]`).forEach(el => el.removeAttribute(EXCL_MARKER));
}

/** Remove all marked elements from a detached clone or fragment. */
function removeMarked(root: Element | DocumentFragment): void {
  (root as Element).querySelectorAll(`[${EXCL_MARKER}]`).forEach(el => el.remove());
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
  const clone = document.body.cloneNode(true) as HTMLElement;
  sizeCleanup();
  cleanup();

  clone.querySelector('discerned-overlay')?.remove();
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

type SiteTagger = (root: Document | Element) => Element | void;

const SITE_TAGGERS: Array<{ match: (host: string) => boolean; tag: SiteTagger; name: string }> = [
  { name: 'primal', match: h => /(^|\.)primal\.net$/i.test(h), tag: tagPrimal },
  { name: 'bsky', match: h => /(^|\.)bsky\.app$/i.test(h), tag: tagBsky },
];

/**
 * Apply the matching site tagger (if any) to the document. Called from
 * extractArticle before the layout-finder/Readability path runs so the
 * captured HTML carries dx-* markers regardless of which tier wins.
 * Sets siteTaggerActive (so the generic semantic-structure pass is skipped)
 * and siteTaggerRoot (the narrowed capture root, when the tagger returns one).
 */
function applySiteTagger(): boolean {
  const host = window.location.hostname;
  for (const t of SITE_TAGGERS) {
    if (t.match(host)) {
      log(LL.NORMAL, `Discerned: applying ${t.name} site tagger`, 'url:', window.location.href);
      try {
        const root = t.tag(document);
        siteTaggerRoot = root ?? null;
        if (root) log(LL.NORMAL, `Discerned: ${t.name} tagger returned narrowed root <${root.tagName.toLowerCase()}>`, 'url:', window.location.href);
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

// ── Semantic structure tagging (generic fallback) ────────────────────────────
//
// Live pages use flexbox + class-scoped CSS to lay out headers (avatar | name)
// and quoted-post cards. After sanitisation strips those classes, default
// block flow stacks everything vertically and links underline their children.
// Stamp our own `dx-*` class markers on detected structures so the web app's
// CSS can restore the intended layout.

const HEADER_AVATAR_MAX_PX = 72;
const HEADER_NAME_MAX_CHARS = 80;
const QUOTE_MIN_TEXT_CHARS = 40;
const STATS_MIN_ICON_SIBLINGS = 3;

function appendClass(el: Element, token: string): void {
  const existing = el.getAttribute('class') ?? '';
  if (existing.split(/\s+/).includes(token)) return;
  el.setAttribute('class', existing ? `${existing} ${token}` : token);
}

/** True if the element directly contains a small image (avatar-sized). */
function hasAvatarImage(el: Element): HTMLImageElement | null {
  const imgs = el.querySelectorAll('img');
  for (const img of Array.from(imgs)) {
    const w = parseInt(img.getAttribute('width') ?? '0', 10);
    const h = parseInt(img.getAttribute('height') ?? '0', 10);
    if (w > 0 && h > 0 && w <= HEADER_AVATAR_MAX_PX && h <= HEADER_AVATAR_MAX_PX) {
      return img;
    }
  }
  return null;
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

  // Stats rows BEFORE headers — so a stats container isn't also mis-tagged
  // as a header just because one of its many children happens to contain an
  // icon image (primal's "top zaps" preview avatars do exactly this). The
  // header pass below skips elements already tagged dx-stats.
  root.querySelectorAll('*').forEach(parent => {
    const children = Array.from(parent.children);
    if (children.length < STATS_MIN_ICON_SIBLINGS) return;
    const actionChildren = children.filter(c =>
      c.tagName.toLowerCase() === 'button' || c.querySelector('svg')
    );
    if (actionChildren.length >= STATS_MIN_ICON_SIBLINGS &&
        actionChildren.length / children.length >= 0.6) {
      appendClass(parent, 'dx-stats');
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
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      // A stats child means this is not a header.
      if (c.classList.contains('dx-stats')) { stop = true; break; }
      const hasAvatar = !!hasAvatarImage(c);
      const text = (c.textContent ?? '').trim();
      if (hasAvatar && text.length < 4) {
        if (avatarChildIdx === -1) avatarChildIdx = i;
      } else if (!hasAvatar && text.length > 0 && text.length <= HEADER_NAME_MAX_CHARS * 2) {
        if (nameChildIdx === -1) nameChildIdx = i;
      }
    }
    if (stop || avatarChildIdx < 0 || nameChildIdx < 0) continue;
    if (el.querySelectorAll('*').length > 40) continue;
    appendClass(el, 'dx-header');
    headerTagged.push(el);
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
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
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
    .replace(/behavior\s*:/gi, '');
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
      if (!isSafeImageSrc(attr.value)) element.removeAttribute('src');
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
  const liveImgs = Array.from(liveRoot.querySelectorAll('img'));
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
  return () => {
    annotated.forEach(({ img, hadWidth, hadHeight }) => {
      if (!hadWidth) img.removeAttribute('width');
      if (!hadHeight) img.removeAttribute('height');
      img.removeAttribute(SIZE_MARKER);
    });
  };
}

/** Strip the size marker from a cloned tree (the marker attr survives cloneNode). */
function stripSizeMarkers(root: Element | DocumentFragment): void {
  (root as Element).querySelectorAll(`[${SIZE_MARKER}]`).forEach(el => el.removeAttribute(SIZE_MARKER));
}

/**
 * Replace Twitter's video player structure with a plain <img src="poster"> so that
 * GIFs and video thumbnails survive sanitisation. Replaces the nearest
 * [data-testid="tweetPhoto"] ancestor when present (which removes Twitter's aspect-ratio
 * sizer divs that would otherwise constrain the image size), otherwise replaces the
 * <video> element directly.
 */
function substituteVideosWithPosters(root: Element | DocumentFragment): void {
  (root as Element).querySelectorAll('video[poster]').forEach(video => {
    const poster = video.getAttribute('poster');
    if (!poster || !isSafeImageSrc(poster)) { const container = video.closest('[data-testid="tweetPhoto"]'); if (container) { container.remove(); } else { video.remove(); } return; }
    const img = document.createElement('img');
    img.src = poster;
    img.alt = video.getAttribute('aria-label') ?? 'Video';
    const container = video.closest('[data-testid="tweetPhoto"]');
    (container ?? video).replaceWith(img);
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

function sanitiseTreeInPlace(root: Element, stripStyles = false) {
  // Drop dangerous elements outright before walking. <foreignObject> can host
  // arbitrary HTML inside <svg>; drop it explicitly even though it's not in the
  // SVG whitelist (the walk-unwrap below would otherwise leak its children).
  root.querySelectorAll('script, style, iframe, object, embed, link, meta, noscript, foreignObject').forEach(el => el.remove());

  const walk = (node: Node) => {
    Array.from(node.childNodes).forEach(walk);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    sanitiseElement(node as Element, stripStyles);
  };
  Array.from(root.childNodes).forEach(walk);

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
      // Many news sites (CNN, etc.) lazy-load with data-src; prefer it over a
      // placeholder 1×1 src. Also check data-lazy-src used by some WordPress themes.
      const raw =
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        img.getAttribute('src');
      if (!raw) continue;
      let abs: string;
      try {
        abs = new URL(raw, baseUrl).toString();
      } catch {
        continue;
      }
      const inlined = await inlineImage(abs);
      img.setAttribute('src', inlined);
      // Remove lazy-load attributes so the stored HTML is self-contained.
      img.removeAttribute('data-src');
      img.removeAttribute('data-lazy-src');
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
