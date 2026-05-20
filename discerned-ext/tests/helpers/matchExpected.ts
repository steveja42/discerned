// Fuzzy matcher that asserts a Capture against an ExpectedCapture sidecar.
// Used by both the Vitest extension suite and the Playwright e2e specs.

import { expect } from 'vitest';
import type { Capture, ClipFormat } from '@/shared/types';

export interface ExpectedCapture {
  format: ClipFormat;
  title?: { contains?: string; equals?: string; matches?: string };
  url: string;
  bodyText?: { minLength?: number; contains?: string[] };
  bodyHtml?: { hasImgs?: boolean; noScripts?: true; allowsOnly?: string[]; containsClasses?: string[] };
  thumbnail?: 'present' | 'absent';
  selectionText?: { contains?: string };
}

const SCRIPT_RE   = /<script[\s>]/i;
const EVENT_RE    = /\son\w+\s*=/i;
// Only flag javascript: inside attribute values, not in body text — the latter
// is just an article *about* javascript: URLs and is harmless.
const JS_HREF_RE  = /=\s*["']?\s*javascript\s*:/i;
const IFRAME_RE   = /<iframe[\s>]/i;
const FORM_RE     = /<form[\s>]/i;

export function matchExpected(cap: Capture, exp: ExpectedCapture): void {
  expect(cap.format, 'format').toBe(exp.format);
  expect(cap.url, 'url').toBe(exp.url);

  if (exp.title?.equals !== undefined) {
    expect(cap.title).toBe(exp.title.equals);
  }
  if (exp.title?.contains !== undefined) {
    expect(cap.title).toContain(exp.title.contains);
  }
  if (exp.title?.matches !== undefined) {
    expect(cap.title).toMatch(new RegExp(exp.title.matches));
  }

  if (exp.bodyText) {
    const text = cap.bodyText ?? '';
    if (exp.bodyText.minLength !== undefined) {
      expect(text.length, `bodyText.length >= ${exp.bodyText.minLength}`)
        .toBeGreaterThanOrEqual(exp.bodyText.minLength);
    }
    for (const needle of exp.bodyText.contains ?? []) {
      expect(text, `bodyText contains "${needle}"`).toContain(needle);
    }
  }

  if (exp.bodyHtml) {
    const html = cap.bodyHtml ?? '';
    if (exp.bodyHtml.noScripts) {
      expect(html, 'no <script>').not.toMatch(SCRIPT_RE);
      expect(html, 'no inline event handlers').not.toMatch(EVENT_RE);
      expect(html, 'no javascript: hrefs').not.toMatch(JS_HREF_RE);
      expect(html, 'no <iframe>').not.toMatch(IFRAME_RE);
      expect(html, 'no <form>').not.toMatch(FORM_RE);
    }
    if (exp.bodyHtml.hasImgs) {
      expect(html, 'has <img>').toMatch(/<img[\s>]/i);
    }
    for (const cls of exp.bodyHtml.containsClasses ?? []) {
      expect(html, `bodyHtml contains class="${cls}"`).toMatch(
        new RegExp(`class\\s*=\\s*"[^"]*\\b${cls}\\b[^"]*"`),
      );
    }
  }

  if (exp.thumbnail === 'present') {
    expect(cap.thumbnail, 'thumbnail present').toBeTruthy();
  } else if (exp.thumbnail === 'absent') {
    expect(cap.thumbnail ?? null, 'thumbnail absent').toBeNull();
  }

  if (exp.selectionText?.contains !== undefined) {
    expect(cap.selectionText ?? '').toContain(exp.selectionText.contains);
  }
}
