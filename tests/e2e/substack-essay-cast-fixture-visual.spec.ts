// Cast-side pixel baseline for PLAIN PROSE — the control case.
//
// Reuses the existing substack-essay fixture (no new snapshot needed) so the
// cast baselines include one document with no code, no inline links, and no
// bold: if a Phase 2/3 fix to the inline-boundary handling damages ordinary
// paragraphs, this is the baseline that catches it. Its clip twin is
// substack-essay-fixture-visual.spec.ts.
//
// Run with: CAST_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=substack-essay-cast-fixture-visual

import { test } from '@playwright/test';
import { runCastFixtureVisual } from './helpers/castFixtureVisual';

test.describe.configure({ mode: 'serial' });

test('substack-essay-cast-fixture-visual', async () => {
  test.skip(!process.env.CAST_FIX, 'set CAST_FIX=1 to run');
  test.setTimeout(180_000);
  await runCastFixtureVisual({
    site: 'substack-essay',
    castMustNotContain: ['**', '](' ],
  });
});
