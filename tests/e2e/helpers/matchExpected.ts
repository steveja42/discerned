// Playwright-side mirror of the Vitest matcher in
// discerned-ext/tests/helpers/matchExpected.ts. Kept here as a Playwright-friendly
// copy (it imports @playwright/test's expect, not vitest's) so the spec files
// don't need cross-package reach.

import { expect } from '@playwright/test';

export interface ExpectedCapture {
  format: 'selection' | 'article' | 'full-page' | 'bookmark';
  title?: { contains?: string; equals?: string; matches?: string };
  url: string;
  bodyText?: { minLength?: number; contains?: string[] };
  bodyHtml?: { hasImgs?: boolean; noScripts?: true; allowsOnly?: string[]; containsClasses?: string[] };
  thumbnail?: 'present' | 'absent';
  selectionText?: { contains?: string };
}

interface CapturePartial {
  format: string; url: string; title: string;
  bodyText?: string; bodyHtml?: string;
  thumbnail?: string | null; selectionText?: string;
  id?: string; timestamp?: number;
}

const SCRIPT_RE   = /<script[\s>]/i;
const EVENT_RE    = /\son\w+\s*=/i;
// Only flag javascript: inside attribute values, not body text.
const JS_HREF_RE  = /=\s*["']?\s*javascript\s*:/i;
const IFRAME_RE   = /<iframe[\s>]/i;
const FORM_RE     = /<form[\s>]/i;

export function matchExpected(cap: CapturePartial, exp: ExpectedCapture): void {
  expect(cap.format, 'format').toBe(exp.format);
  expect(cap.url, 'url').toBe(exp.url);

  if (exp.title?.equals !== undefined) expect(cap.title).toBe(exp.title.equals);
  if (exp.title?.contains !== undefined) expect(cap.title).toContain(exp.title.contains);
  if (exp.title?.matches !== undefined) expect(cap.title).toMatch(new RegExp(exp.title.matches));

  if (exp.bodyText) {
    const text = cap.bodyText ?? '';
    if (exp.bodyText.minLength !== undefined) {
      expect(text.length).toBeGreaterThanOrEqual(exp.bodyText.minLength);
    }
    for (const needle of exp.bodyText.contains ?? []) {
      expect(text).toContain(needle);
    }
  }

  if (exp.bodyHtml) {
    const html = cap.bodyHtml ?? '';
    if (exp.bodyHtml.noScripts) {
      expect(html).not.toMatch(SCRIPT_RE);
      expect(html).not.toMatch(EVENT_RE);
      expect(html).not.toMatch(JS_HREF_RE);
      expect(html).not.toMatch(IFRAME_RE);
      expect(html).not.toMatch(FORM_RE);
    }
    if (exp.bodyHtml.hasImgs) expect(html).toMatch(/<img[\s>]/i);
    for (const cls of exp.bodyHtml.containsClasses ?? []) {
      expect(html, `bodyHtml contains class="${cls}"`).toMatch(
        new RegExp(`class\\s*=\\s*"[^"]*\\b${cls}\\b[^"]*"`),
      );
    }
  }

  if (exp.thumbnail === 'present') expect(cap.thumbnail ?? null).not.toBeNull();
  if (exp.thumbnail === 'absent')  expect(cap.thumbnail ?? null).toBeNull();

  if (exp.selectionText?.contains !== undefined) {
    expect(cap.selectionText ?? '').toContain(exp.selectionText.contains);
  }
}
