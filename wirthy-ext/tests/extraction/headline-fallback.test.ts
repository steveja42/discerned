// Guards withHeadlineFallback — headline recovery for the case where the
// captured root starts BELOW the page's <h1>.
//
// Measured 2026-09-16 (tools/finder-diag-probe.spec.ts, Phase 5a): on cnn,
// fortune, gizmodo, pcmag, zdnet, newsweek and motherjones the CMS renders the
// headline in a <header> that is a SIBLING of the <article> holding the body,
// so Tier 1 wins a root with the whole story and no title. All 7 reported
// holdsHeadline=false / headlinePrecedes=true, and all 7 captured a body with
// the headline text absent entirely.
//
// The fix prepends one <h1> rather than widening the root, because widening is
// what the remediation plan feared and the measurements justify that fear: on
// cnn the nearest common ancestor holds 20,886 chars against the article's
// 5,910. Prepending adds the title and nothing else, whatever the gap holds.
//
// The negative cases below are the point of this file. A recovery that can put
// the WRONG text at the top of a clip is worse than no recovery, so each guard
// has a test that fails if it is removed.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

const FIXTURE = 'article-headline-outside-root.html';
const PAGE_URL = 'https://www.example-post.com/2026/09/01/hospital-roof-death/';
const HEADLINE = 'Hospital slashed costs, then a patient froze to death on its roof';

describe('headline recovery (withHeadlineFallback)', () => {
  for (const smartArticleDetection of [false, true]) {
    it(`recovers the headline when the root starts below it (smartArticleDetection=${smartArticleDetection})`, async () => {
      loadFixture(FIXTURE, PAGE_URL);
      const cap = await captureContext('article', { smartArticleDetection, stripInlineStyles: false });
      const body = cap.bodyHtml ?? '';

      expect(body, 'headline recovered into the clip body').toContain(HEADLINE);
      // As a HEADING, not stray text: the sweep verdicts describe a clip that
      // opens without a title, which a bare text node would not fix.
      expect(body).toMatch(/<h1[^>]*>\s*Hospital slashed costs/i);
      // It must LEAD the body — a headline after the first paragraph is not a
      // headline.
      expect(body.indexOf(HEADLINE), 'headline is at the top')
        .toBeLessThan(body.indexOf('The hospital had been cutting costs'));
      // The story itself is untouched — this is additive.
      expect(cap.bodyText ?? '').toContain('condenser unit on the north side of the roof');
    });
  }

  it('does NOT promote a rail heading that is not this page\'s headline', async () => {
    // "Related stories" sits outside the capture root too, and is the nearest
    // heading to the article in document order AFTER it. Only the word-overlap
    // test against the page <title> separates them, so removing that guard
    // makes this fail.
    loadFixture(FIXTURE, PAGE_URL);
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.bodyHtml ?? '').not.toMatch(/<h1[^>]*>\s*Related stories/i);
  });

  it('recovers even though the body has SECTION subheads of its own', async () => {
    // The guard asks whether the body LEADS with a heading, not whether it has
    // one. Measured 2026-09-16: 5 of the 7 Phase 5a domains carry ordinary
    // <h2>/<h3> subheads (zdnet has 10), so an any-heading test made the
    // recovery a no-op on exactly the pages it exists for — only cnn and
    // gizmodo, which happen to have none, were fixed. The fixture's "What the
    // records show" subhead pins that.
    loadFixture(FIXTURE, PAGE_URL);
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const body = cap.bodyHtml ?? '';
    expect(body, 'body does carry a section subhead').toContain('What the records show');
    expect(body, 'and the headline is still recovered').toMatch(/<h1[^>]*>\s*Hospital slashed costs/i);
  });

  it('does not add a second heading when the root already has one', async () => {
    // The og:image fixture puts the <h1> INSIDE the <article>. Recovery must
    // be a no-op there: a page that captures its own title needs nothing, and
    // prepending would duplicate it.
    loadFixture('article-og-image-no-body-img.html',
      'https://www.msn.com/en-us/money/general/astrazeneca-hit/ar-AA29gc1N');
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    const heads = (cap.bodyHtml ?? '').match(/<h1[^>]*>/gi) ?? [];
    expect(heads.length, 'exactly one <h1>, not a duplicate').toBeLessThanOrEqual(1);
    const hits = (cap.bodyText ?? '').split('AstraZeneca suffers').length - 1;
    expect(hits, 'title text appears once').toBeLessThanOrEqual(1);
  });
});
