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

async function extractArticle(opts: CaptureOptions): Promise<Capture> {
  const base = baseFields();
  log(LL.DEBUG, `Discerned: extractArticle — smartArticleDetection=${opts.smartArticleDetection} stripInlineStyles=${opts.stripInlineStyles}`, 'url:', base.url);

  // Tier 0: Twitter/X — extract clean tweet card from data-testid selectors.
  if (/^https?:\/\/(www\.)?(twitter|x)\.com\//i.test(window.location.href)) {
    const tweet = await extractTweet(base);
    if (tweet) return tweet;
    log(LL.DEBUG, 'Discerned: Twitter extractor yielded nothing, falling through to generic', 'url:', base.url);
  }

  const thumbnailUrl = getPageThumbnail();
  const inlinedThumbnail = thumbnailUrl ? await inlineImage(thumbnailUrl) : null;

  // Tier 1: semantic article element — preserves images at their correct positions.
  const articleEl = findArticleElement(opts.smartArticleDetection);
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
    const imgsBefore = clone.querySelectorAll('img').length;
    sanitiseTreeInPlace(clone as HTMLElement, opts.stripInlineStyles);
    const imgsAfter = clone.querySelectorAll('img[style]').length;
    log(LL.DEBUG, `Discerned: sanitiseTreeInPlace done — ${imgsBefore} imgs, ${imgsAfter} with remaining inline style, stripInlineStyles=${opts.stripInlineStyles}`, 'url:', base.url);
    log(LL.DEBUG, `Discerned: sanitised bodyHtml (first 2000 chars): ${clone.innerHTML.slice(0, 2000)}`, 'url:', base.url);
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
    const bodyClone = document.body.cloneNode(true) as HTMLElement;
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
const ALLOWED_ATTRS_GLOBAL = new Set(['style']);
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

const MAX_SVGS_PER_ARTICLE = 50;

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

function sanitiseElement(element: Element, stripStyles = false) {
  const tagName = element.tagName.toLowerCase();

  if (!ALLOWED_TAGS.has(tagName)) {
    element.replaceWith(...Array.from(element.childNodes));
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
    } else if (tagName === 'img' && name === 'src') {
      if (!isSafeImageSrc(attr.value)) element.removeAttribute('src');
    } else if (tagName === 'a' && name === 'href') {
      if (!isSafeHref(attr.value)) element.removeAttribute('href');
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
    if (!poster || !isSafeImageSrc(poster)) { video.closest('[data-testid="tweetPhoto"]')?.remove() ?? video.remove(); return; }
    const img = document.createElement('img');
    img.src = poster;
    img.alt = video.getAttribute('aria-label') ?? 'Video';
    const container = video.closest('[data-testid="tweetPhoto"]');
    (container ?? video).replaceWith(img);
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
