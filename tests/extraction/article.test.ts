import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';
import { matchExpected, type ExpectedCapture } from '../helpers/matchExpected';
import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { resolve, basename } from 'node:path';

const FIXTURE_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'sites');

interface FixtureCase {
  name: string;
  url: string;
  expected: ExpectedCapture;
}

const fixtures: FixtureCase[] = fg
  .sync('*.html', { cwd: FIXTURE_ROOT })
  .map((file) => {
    const name = basename(file);
    const sidecarPath = resolve(FIXTURE_ROOT, `${name.replace(/\.html$/, '')}.expected.json`);
    const expected = JSON.parse(readFileSync(sidecarPath, 'utf8')) as ExpectedCapture;
    return { name, url: expected.url, expected };
  });

describe('article extraction (parametric corpus)', () => {
  for (const fx of fixtures) {
    it(`extracts ${fx.name} matching its sidecar`, async () => {
      loadFixture(fx.name, fx.url);
      const cap = await captureContext('article', {
        smartArticleDetection: true,
        stripInlineStyles: false,
      });
      matchExpected(cap, fx.expected);
      // Common invariants regardless of fixture:
      expect(cap.id).toBeTruthy();
      expect(cap.timestamp).toBeGreaterThan(0);
    });
  }
});
