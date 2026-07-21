import { describe, it, expect } from 'vitest';
import { captureContext, __setTestHostOverride } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';
import { matchExpected, type ExpectedCapture } from '../helpers/matchExpected';
import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { resolve, basename } from 'node:path';

const FIXTURE_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'sites');

interface FixtureCase {
  name: string;
  url: string;
  hostOverride?: string;
  expected: ExpectedCapture;
}

const fixtures: FixtureCase[] = fg
  .sync('*.html', { cwd: FIXTURE_ROOT })
  .map((file) => {
    const name = basename(file);
    const sidecarPath = resolve(FIXTURE_ROOT, `${name.replace(/\.html$/, '')}.expected.json`);
    const expected = JSON.parse(readFileSync(sidecarPath, 'utf8')) as ExpectedCapture;
    return { name, url: expected.url, hostOverride: expected.hostOverride, expected };
  });

describe('article extraction (parametric corpus)', () => {
  for (const fx of fixtures) {
    it(`extracts ${fx.name} matching its sidecar`, async () => {
      loadFixture(fx.name, fx.url);
      // Fixtures whose expected content is only produced by their real per-site
      // tagger carry a hostOverride; feed it so the tagger fires under jsdom too
      // (taggers otherwise gate on the 127.0.0.1 fixture hostname). Sidecar
      // assertions stay tagger-AGNOSTIC text (dx-* class validation belongs to
      // the Playwright fixture-visual specs — jsdom can't lay out dx-* markers).
      if (fx.hostOverride) __setTestHostOverride(fx.hostOverride);
      try {
        const cap = await captureContext('article', {
          smartArticleDetection: true,
          stripInlineStyles: false,
        });
        matchExpected(cap, fx.expected);
        // Common invariants regardless of fixture:
        expect(cap.id).toBeTruthy();
        expect(cap.timestamp).toBeGreaterThan(0);
      } finally {
        __setTestHostOverride(null);
      }
    });
  }
});
