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
    castMustContain: [
      // The PLAIN block — the counter-example that renders correctly TODAY and
      // must keep doing so. A Phase 2 fix that narrows the spacing pass must
      // not disturb this, and it is the evidence that the cause is element
      // boundaries rather than "code".
      'kubectl apply -f pod.yaml',
      'kubectl get pods --namespace default',
    ],
    // The baseline deliberately records the BROKEN render — measured
    // 2026-09-15, before any Phase 2 work. Each of these is a padded token
    // boundary reproducing a specific site from the sweep. When Phase 2 lands,
    // this spec fails saying they are gone: move them to castMustNotContain and
    // refresh the baseline in the same commit.
    knownBroken: {
      'apiVersion : v1': 'Phase 2 — kubernetes-docs (highlighted YAML)',
      'r . json ( )': 'Phase 2 — python-docs / pypi',
      'use serde :: { Deserialize , Serialize }': 'Phase 2 — crates-io',
      '( nonstandard )': 'Phase 2 — wiktionary (padding in PROSE, not code)',
    },
  });
});
