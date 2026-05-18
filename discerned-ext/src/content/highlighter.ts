// Role: Content Script — on-page article rectangle
// Description: Detects the live-DOM article container with a lightweight heuristic and draws a
//              floating outline div over its bounding rect, Evernote-style. The outline updates on
//              scroll/resize so it stays anchored to the article as the user navigates the page.
// Access: DOM (document.querySelector, getBoundingClientRect, ResizeObserver, scroll/resize events)

let outlineEl: HTMLDivElement | null = null;
let targetEl: Element | null = null;
let scrollListener: (() => void) | null = null;
let resizeListener: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let rafHandle: number | null = null;

/**
 * Heuristic: pick the element on the live page that most likely contains the article.
 * Tries <article> first, then <main>, then the largest text-density block.
 *
 * Kept independent of Readability — Readability operates on a clone and provides no
 * stable mapping back to the live DOM, so we re-detect here using cheap DOM heuristics.
 */
export function detectArticleContainer(): Element | null {
  const articleEls = Array.from(document.querySelectorAll('article'));
  if (articleEls.length > 0) {
    return pickLargestByText(articleEls);
  }

  const main = document.querySelector('main');
  if (main) return main;

  // Fallback: scan candidate containers by text density.
  const candidates = Array.from(
    document.querySelectorAll('section, div[role="main"], div.post, div.entry, div.content, div#content'),
  );
  if (candidates.length === 0) return document.body;
  return pickLargestByText(candidates);
}

function pickLargestByText(elements: Element[]): Element | null {
  let best: Element | null = null;
  let bestLen = 0;
  for (const el of elements) {
    const text = (el.textContent || '').trim();
    if (text.length > bestLen) {
      bestLen = text.length;
      best = el;
    }
  }
  return best;
}

/**
 * Show a fixed-position outline rectangle over the detected article element.
 * Returns the outline element so the caller (overlay) can append it into its Shadow DOM.
 */
export function showArticleHighlight(): HTMLDivElement | null {
  hideArticleHighlight();

  const target = detectArticleContainer();
  if (!target) return null;
  targetEl = target;

  const div = document.createElement('div');
  div.setAttribute('data-discerned-highlight', '');
  div.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 2147483646',
    'border: 2px solid #0ea5e9',
    'border-radius: 4px',
    'box-shadow: 0 0 0 9999px rgba(0,0,0,0.08)',
    'transition: top 0.05s linear, left 0.05s linear, width 0.05s linear, height 0.05s linear',
  ].join(';');
  document.body.appendChild(div);
  outlineEl = div;

  const update = () => {
    if (!outlineEl || !targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    outlineEl.style.top = `${rect.top}px`;
    outlineEl.style.left = `${rect.left}px`;
    outlineEl.style.width = `${rect.width}px`;
    outlineEl.style.height = `${rect.height}px`;
  };

  const schedule = () => {
    if (rafHandle !== null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      update();
    });
  };

  scrollListener = schedule;
  resizeListener = schedule;
  window.addEventListener('scroll', scrollListener, { passive: true });
  window.addEventListener('resize', resizeListener, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(target);
    resizeObserver.observe(document.body);
  }

  update();
  return div;
}

export function hideArticleHighlight(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (scrollListener) {
    window.removeEventListener('scroll', scrollListener);
    scrollListener = null;
  }
  if (resizeListener) {
    window.removeEventListener('resize', resizeListener);
    resizeListener = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (outlineEl && outlineEl.parentNode) {
    outlineEl.parentNode.removeChild(outlineEl);
  }
  outlineEl = null;
  targetEl = null;
}
