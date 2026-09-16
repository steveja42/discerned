// Cast-side pixel baseline: WHITESPACE CORRUPTION inside syntax-highlighted
// code (CAPTURE-FLAW-REMEDIATION-PLAN.md Phase 2, ~20 sites).
//
// The fixture pairs highlighted blocks (every token its own <span>, no
// whitespace text nodes between them — what Prism/Rouge/highlight.js emit)
// against a PLAIN shell block in the same document. That pairing is the whole
// point: on kubernetes-docs the highlighted YAML was destroyed on the same page
// where a plain shell block beside it was perfect, which is what proves the
// cause is element boundaries rather than "code".
//
// Suspect for the padding half: separateInlineFacets in
// discerned-ext/src/content/html-to-markdown.ts, whose INLINE_FACET_TAGS
// includes SPAN and CODE — so it inserts a space at every token boundary. It
// exists to unglue Bluesky facets ("#TRCMP RCMP#TRCMP"), so narrowing it must
// keep that working; bsky-thread's cast is the counter-guard.
//
// Run with: CAST_FIX=1 pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=highlighted-code-cast-fixture-visual

import { test } from '@playwright/test';
import { runCastFixtureVisual } from './helpers/castFixtureVisual';

test.describe.configure({ mode: 'serial' });

test('highlighted-code-cast-fixture-visual', async () => {
  test.skip(!process.env.CAST_FIX, 'set CAST_FIX=1 to run');
  test.setTimeout(180_000);
  await runCastFixtureVisual({
    site: 'highlighted-code-docs',
    // Tighter than the 0.02 default ON PURPOSE. The Phase 2 repair changed
    // 1.46% of pixels — real, visible, and SILENT at the default tolerance,
    // which passed while the baseline still recorded the broken render. Only
    // the string assertions caught it. Monospace text of near-identical length
    // is exactly the content a ratio gate is worst at, so this fixture gates
    // tighter than the photo-bearing clip baselines need to.
    maxDiffPixelRatio: 0.002,
    castMustContain: [
      // The PLAIN block — the counter-example that renders correctly TODAY and
      // must keep doing so. A Phase 2 fix that narrows the spacing pass must
      // not disturb this, and it is the evidence that the cause is element
      // boundaries rather than "code".
      'kubectl apply -f pod.yaml',
      'kubectl get pods --namespace default',
      // The repaired text, asserted positively so the spec says what RIGHT
      // looks like rather than only what wrong looked like.
      'apiVersion: v1',
      'data = r.json()',
      'use serde::{Deserialize, Serialize};',
      'required (nonstandard) on older clusters',
    ],
    // Phase 2 FIXED these (2026-09-16) — each was a padded token boundary
    // reproducing a specific sweep site, and each was `knownBroken` until
    // separateInlineFacets gained its preformatted + punctuation-glue guards.
    // The baseline was refreshed in the same commit.
    castMustNotContain: [
      'apiVersion : v1',                          // kubernetes-docs (highlighted YAML)
      'r . json ( )',                             // python-docs / pypi
      'use serde :: { Deserialize , Serialize }', // crates-io
      '( nonstandard )',                          // wiktionary (padding in PROSE, not code)
    ],
  });
});
