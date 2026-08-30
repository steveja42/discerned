// Shared fixture loader for Playwright specs. Reads the same .expected.json
// sidecars that the Vitest extension suite uses.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { ExpectedCapture } from './matchExpected';

export const FIXTURE_ROOT = resolve(__dirname, '..', '..', 'fixtures', 'sites');
export const CLIPS_ROOT = resolve(__dirname, '..', '..', 'fixtures', 'clips');

export const FIXTURE_ORIGIN = 'http://127.0.0.1:4173';

export interface SiteFixture {
  htmlName: string;        // e.g. "blog-post.html"
  url: string;             // http://127.0.0.1:4173/blog-post.html — where to NAVIGATE
  hostOverride?: string;   // e.g. "www.reddit.com" — fires the real site tagger
  expected: ExpectedCapture;
}

/**
 * The sidecar's `url` is the location to SIMULATE, not a navigation target. The
 * Vitest suite fakes `window.location` with it (see
 * discerned-ext/tests/helpers/loadFixture.ts), so fixtures whose capture path
 * branches on hostname — Amazon entity pages, YouTube, AP — legitimately carry
 * their real source URL there.
 *
 * Playwright must NOT navigate to that: this suite is the deterministic offline
 * gate, and loading the live site asserts a saved snapshot's expectations
 * against today's web (apnews/amazon/dev.to fixtures all failed that way, and
 * hackernews/x-status passed only by luck). Hostname-dependence is handled by
 * `hostOverride` instead — that mechanism exists precisely so the real tagger
 * fires against the 127.0.0.1-served file.
 *
 * So the navigation target is derived from the FILENAME, always local.
 */
export function loadSiteFixtures(): SiteFixture[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((f) => f.endsWith('.html'))
    // A sidecar is what makes an HTML file part of the CAPTURE corpus. The same
    // directory also holds pages the fixture-server serves for other specs (the
    // click-jacking page, say), which have nothing to assert a capture against —
    // without this they'd throw ENOENT here and take the whole spec file down.
    .filter((f) => existsSync(resolve(FIXTURE_ROOT, `${basename(f, '.html')}.expected.json`)))
    .map((file) => {
      const htmlName = basename(file);
      const sidecar = resolve(FIXTURE_ROOT, `${htmlName.replace(/\.html$/, '')}.expected.json`);
      const expected = JSON.parse(readFileSync(sidecar, 'utf8')) as ExpectedCapture;
      return {
        htmlName,
        url: `${FIXTURE_ORIGIN}/${htmlName}`,
        hostOverride: expected.hostOverride,
        expected,
      };
    });
}

export interface ClipFixture {
  name: string;
  capture: {
    id: string; format: 'selection' | 'article' | 'full-page' | 'bookmark';
    url: string; title: string; timestamp: number; note?: string;
    selectionText?: string; selectionContext?: string;
    bodyHtml?: string; bodyText?: string; thumbnail?: string | null;
  };
  evaluation: { signal?: string; qualifiers: string[]; category: string };
}

export function loadClipFixtures(): ClipFixture[] {
  return readdirSync(CLIPS_ROOT)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const data = JSON.parse(readFileSync(resolve(CLIPS_ROOT, file), 'utf8'));
      return { name: file, ...data };
    });
}
