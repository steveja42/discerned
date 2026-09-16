// Cast-side pixel baseline covering three of the four cast failure modes from
// CAPTURE-FLAW-REMEDIATION-PLAN.md Phase 0:
//
//   * inline links surviving intact (the Phase 3 grey-pill defect) — several
//     links in one paragraph, including one whose source anchor wrapped an
//     image, plus a PROSE link to an embeddable video provider. That last one
//     is the actual reproduction: DetailPanel's markdown <a> renderer marked a
//     link .tweet-video on the HREF alone, so a sentence fragment became a
//     rounded grey box (block + fit-content + overflow:hidden) with the 44px
//     play overlay (absolute, inset:0, dark panel) across its middle. The CSS
//     pill rules (.clip-body a:has(img) + a and a:has(img) ~ a:nth-of-type(3),
//     globals.css ~1792) were checked in Phase 0 and RULED OUT — casts drop
//     inlined images, so :has(img) can never match in a cast body.
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
      // This one points at YouTube — the href that triggered the play-card
      // misfire. It must read as ordinary prose, not a card.
      'sat down to talk with David Senra',
      // Paragraph separation: this short closing paragraph must stand alone.
      'Somebody noticed.',
    ],
    castMustNotContain: [
      // Literal markdown syntax leaking as visible text.
      '**',
      '![',
      '](',
      // The play overlay's glyph. It is a text node inside the anchor, so it
      // lands in innerText whenever a prose link is wrongly carded.
      '▶',
    ],
  });
});
