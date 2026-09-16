// Cast-side pixel baseline covering three of the four cast failure modes from
// CAPTURE-FLAW-REMEDIATION-PLAN.md Phase 0:
//
//   * inline links surviving intact (the Phase 3 grey-pill regression surface) —
//     several links in one paragraph, including one whose source anchor wrapped
//     an image. NOTE for Phase 3: the CSS pill rules (.clip-body a:has(img) + a
//     and a:has(img) ~ a:nth-of-type(3), discerned-web/app/globals.css ~1792)
//     were checked as the cause and RULED OUT for casts — casts drop inlined
//     images entirely, so :has(img) can never match in a cast body. This fixture
//     renders clean today; it is the guard that link text stays unsliced
//     ("Tru"▸"said") while Phase 2/3 work touches inline boundaries, not a
//     reproduction of the defect. Reproducing that still needs one of the 8
//     affected sites.
//   * literal markdown leakage (Phase 6a, 6 sites) — **bold** rendering as
//     visible asterisks rather than weight.
//   * paragraph-separation loss (plain prose running together).
//
// Run with: CAST_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=linked-prose-cast-fixture-visual

import { test } from '@playwright/test';
import { runCastFixtureVisual } from './helpers/castFixtureVisual';

test.describe.configure({ mode: 'serial' });

test('linked-prose-cast-fixture-visual', async () => {
  test.skip(!process.env.CAST_FIX, 'set CAST_FIX=1 to run');
  test.setTimeout(180_000);
  await runCastFixtureVisual({
    site: 'linked-prose-article',
    castMustContain: [
      // Link text must survive INTACT — the grey-pill defect slices it
      // ("Tru"▸"said", "sat down to tal"▸"th David Senra").
      'Tru Adeyemi',
      'sat down to talk with David Senra',
      // Paragraph separation: this short closing paragraph must stand alone.
      'Somebody noticed.',
    ],
    castMustNotContain: [
      // Literal markdown syntax leaking as visible text.
      '**',
      '![',
      '](',
    ],
  });
});
