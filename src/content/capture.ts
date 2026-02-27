// Role: Content Script — capture layer
// Description: Determines what to capture: selected text (quote, kind 1) or page metadata
//              (resource, kind 1). Sanitizes all HTML through a tag/attribute allowlist.
// Access: DOM (window.getSelection, window.location, document.title, document.querySelector)

import type { CaptureResult, QuoteCapture, ResourceCapture } from '@/shared/types';

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
    return rawUrl; // unparseable — return as-is
  }

  const before = parsed.search;
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
    }
  }

  // Only reconstruct if something was actually removed
  return before === parsed.search ? rawUrl : parsed.toString();
}

export function captureContext(): CaptureResult {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();

  if (selectedText && selectedText.length > 0) {
    // Scenario A: Text is selected -> Quote capture
    return captureQuote(selection!);
  }

  // Scenario B: No text selected -> Resource capture
  return captureResource();
}

/**
 * Capture selected text as a quote with context
 */
function captureQuote(selection: Selection): QuoteCapture {
  const range = selection.getRangeAt(0);
  const container = range.cloneContents();
  
  // Sanitize HTML to prevent XSS
  const sanitized = sanitizeHTML(container);
  
  // Extract surrounding context (100 chars before/after)
  const context = extractContext(range);

  return {
    type: 'quote',
    content: sanitized,
    url: stripTrackingParams(window.location.href),
    context,
    timestamp: Date.now(),
  };
}

/**
 * Capture page metadata as a resource
 */
function captureResource(): ResourceCapture {
  const title = document.title || 'Untitled Page';
  const url = stripTrackingParams(window.location.href);
  
  // Try to get Open Graph image first, fall back to first img
  const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  const firstImg = document.querySelector<HTMLImageElement>('img')?.src;
  const thumbnail = ogImage || firstImg || null;

  return {
    type: 'resource',
    title,
    url,
    thumbnail,
    timestamp: Date.now(),
  };
}

/**
 * Sanitize HTML to prevent XSS attacks.
 * Allowed tags: semantic formatting + span (for syntax highlighting / inline colour).
 * Allowed attributes: href, style (style values are scrubbed of dangerous CSS).
 */
function sanitizeHTML(fragment: DocumentFragment): string {
  const ALLOWED_TAGS = new Set(['b', 'i', 'a', 'p', 'br', 'strong', 'em', 'span']);
  const ALLOWED_ATTRS = new Set(['href', 'style']);

  const div = document.createElement('div');
  div.appendChild(fragment.cloneNode(true));

  // Remove dangerous elements before walking the tree
  div.querySelectorAll('script, style, iframe, object, embed').forEach(el => el.remove());

  // Post-order walk: recurse into children first so that when a disallowed element
  // is replaced with its children, those children are already sanitised.
  // We start on div.childNodes rather than div itself — div is not in ALLOWED_TAGS
  // and would have caused an immediate early-return, leaving the entire fragment
  // unsanitised.
  const walk = (node: Node) => {
    // Snapshot childNodes before recursing; replaceWith() mutates the live list
    Array.from(node.childNodes).forEach(walk);

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }

    // Remove disallowed attributes
    Array.from(element.attributes).forEach(attr => {
      if (!ALLOWED_ATTRS.has(attr.name)) {
        element.removeAttribute(attr.name);
      }
    });

    // Strip dangerous CSS from style values
    const styleVal = element.getAttribute('style');
    if (styleVal !== null) {
      const safe = styleVal
        .replace(/expression\s*\(/gi, '')
        .replace(/javascript\s*:/gi, '')
        .replace(/url\s*\(/gi, '')
        .replace(/-moz-binding/gi, '')
        .replace(/behavior\s*:/gi, '');
      if (safe.trim()) {
        element.setAttribute('style', safe);
      } else {
        element.removeAttribute('style');
      }
    }
  };

  Array.from(div.childNodes).forEach(walk);

  return div.innerHTML.trim();
}

/**
 * Extract context around the selection (for better attribution)
 */
function extractContext(range: Range): string {
  const CONTEXT_LENGTH = 100;
  
  try {
    const startContainer = range.startContainer;
    const textContent = startContainer.textContent || '';
    const startOffset = range.startOffset;

    // Get text before selection
    const before = textContent.substring(
      Math.max(0, startOffset - CONTEXT_LENGTH),
      startOffset
    ).trim();

    // Get text after selection
    const after = textContent.substring(
      range.endOffset,
      Math.min(textContent.length, range.endOffset + CONTEXT_LENGTH)
    ).trim();

    return `...${before} [...] ${after}...`;
  } catch (error) {
    console.warn('Could not extract context:', error);
    return '';
  }
}

/**
 * Utility: Check if current page is capturable
 */
export function isCapturablePage(): boolean {
  const url = window.location.href;
  
  // Block internal chrome pages
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    return false;
  }

  // Block local files (could be enabled later with permission)
  if (url.startsWith('file://')) {
    return false;
  }

  return true;
}
