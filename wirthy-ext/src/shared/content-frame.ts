/**
 * Runs INSIDE a content iframe via executeScript — self-contained, no imports
 * or closures. Returns the body's VISIBLE markup with absolute URLs; tweet
 * embeds (iframe + blockquote) are kept so the page-side tweet substitution
 * can card them.
 */
export function extractFromContentFrame(): string {
  const MAX_HTML = 3_000_000;
  const MARK = 'data-dx-frame-hidden';
  const marked: Element[] = [];
  const isTweet = (el: Element) => el.matches('blockquote.twitter-tweet, iframe[src*="platform.twitter.com"], iframe[data-tweet-id]');
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (isTweet(el) || el.closest('blockquote.twitter-tweet')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') { el.setAttribute(MARK, ''); marked.push(el); }
  }
  const clone = document.body.cloneNode(true) as HTMLElement;
  marked.forEach(el => el.removeAttribute(MARK));
  clone.querySelectorAll(`[${MARK}], script, style, noscript, template, link, meta`).forEach(el => el.remove());
  clone.querySelectorAll('iframe').forEach(f => { if (!isTweet(f)) f.remove(); });
  // Resolve relative URLs against the FRAME's origin — the host page would misresolve them.
  const abs = (v: string | null) => { try { return v ? new URL(v, document.baseURI).href : v; } catch { return v; } };
  clone.querySelectorAll('img[src]').forEach(img => img.setAttribute('src', abs(img.getAttribute('src')) ?? ''));
  clone.querySelectorAll('img').forEach(img => img.removeAttribute('srcset'));
  clone.querySelectorAll('a[href]').forEach(a => a.setAttribute('href', abs(a.getAttribute('href')) ?? ''));
  const html = clone.innerHTML;
  return html.length > MAX_HTML ? '' : html;
}
