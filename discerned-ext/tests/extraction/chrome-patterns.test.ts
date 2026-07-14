// Guards the generic chrome pass (removeGenericChrome) and the flex-separation
// pass (applyFlexSeparation) at the bodyHtml level, where the corpus sidecar's
// prose-only bodyText can't see them. Complements chrome-patterns.expected.json.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('generic chrome removal + flex separation (bodyHtml level)', () => {
  it('drops chrome patterns from bodyHtml and spaces out flex children', async () => {
    loadFixture('chrome-patterns.html', 'http://127.0.0.1:4173/chrome-patterns.html');
    const cap = await captureContext('article', { smartArticleDetection: true, stripInlineStyles: false });
    const html = cap.bodyHtml ?? '';

    // Flex byline children get a space text node between them — authored with
    // NO whitespace in the fixture, so this separator can only come from
    // applyFlexSeparation.
    expect(html).toMatch(/Imran Rahman-Jones<\/span>\s+<span>Technology reporter/);

    // Text-labelled chrome links are gone; article links would survive.
    expect(html).not.toMatch(/>Share</);
    expect(html).not.toMatch(/>Save</);
    expect(html).not.toContain('Improve this question');
    expect(html).not.toContain('Add as preferred');
    expect(html).not.toContain('Skip to content');
    expect(html).not.toContain('Jump to ratings');

    // Recirculation + newsletter + sort chrome are gone wholesale.
    expect(html).not.toContain('Discover more');
    expect(html).not.toContain('Want to know more');
    expect(html).not.toContain('NEVER MISS THE NEWS');
    expect(html).not.toContain('Open comment sort options');
    expect(html).not.toContain('Controversial');

    // "More <topic> stories on <site>" recirculation module removed structurally.
    expect(html).not.toContain('More Geopolitical Stories On ExampleWire');
    expect(html).not.toContain('Ceasefire Talks Falter Again');

    // Trailing tag/category link strip removed (short-link-dominant list).
    expect(html).not.toContain('/t/tariffs');
    expect(html).not.toMatch(/>Tariffs</);
    expect(html).not.toMatch(/>Geneva</);

    // Screen-reader-only duplicates dropped; visible values survive.
    expect(html).not.toContain('gold badges');
    expect(html).toContain('28.1k');

    // Image-viewer lightbox hint is dropped, but the figure/img stays.
    expect(html).not.toContain('Press enter or click to view image');

    // Duplicated engagement rows collapse to one. The fixture authors three
    // identical dx-stats "79 4" rows; only the first survives.
    const statsMatches = html.match(/class="[^"]*\bdx-stats\b/g) ?? [];
    expect(statsMatches.length).toBe(1);

    // The article itself is intact.
    expect(html).toContain('Negotiators from twelve countries');
    expect(html).toContain('signing ceremony');
  });

  it('never removes prose links whose text merely CONTAINS a chrome verb', async () => {
    document.body.innerHTML = `
      <article>
        <h1>Legit Article</h1>
        <p>${'Prose sentence for density and length in the extractor. '.repeat(15)}
          Read the piece <a href="/deep">Share prices tumble as report lands</a> for context.</p>
      </article>`;
    const cap = await captureContext('article');
    expect(cap.bodyHtml ?? '').toContain('Share prices tumble as report lands');
  });
});
