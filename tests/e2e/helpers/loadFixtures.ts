// Shared fixture loader for Playwright specs. Reads the same .expected.json
// sidecars that the Vitest extension suite uses.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { ExpectedCapture } from './matchExpected';

export const FIXTURE_ROOT = resolve(__dirname, '..', '..', 'fixtures', 'sites');
export const CLIPS_ROOT = resolve(__dirname, '..', '..', 'fixtures', 'clips');

export interface SiteFixture {
  htmlName: string;        // e.g. "blog-post.html"
  url: string;             // http://127.0.0.1:4173/blog-post.html
  expected: ExpectedCapture;
}

export function loadSiteFixtures(): SiteFixture[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((f) => f.endsWith('.html'))
    .map((file) => {
      const htmlName = basename(file);
      const sidecar = resolve(FIXTURE_ROOT, `${htmlName.replace(/\.html$/, '')}.expected.json`);
      const expected = JSON.parse(readFileSync(sidecar, 'utf8')) as ExpectedCapture;
      return { htmlName, url: expected.url, expected };
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
