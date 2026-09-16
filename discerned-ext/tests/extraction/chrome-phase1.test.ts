// Phase 1 of the capture-flaw remediation plan: four narrowly-scoped chrome
// removals, each derived from the 2026-09-15 corpus sweep. Each `it` pairs the
// defect with the counter-example that constrains the rule, because in every
// case the naive version of the rule ate real content somewhere in the corpus.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';

// Repeated so Readability keeps the article structure — under jsdom there is no
// layout, so every capture here falls to Readability, and a single sentence is
// below the threshold at which it preserves the surrounding siblings.
const PROSE = 'This is the real body of the article and it is long enough to be chosen as the content block by the layout finder, with plenty of words. '.repeat(3);

// Assertions are on bodyHtml, not bodyText: removeGenericChrome rewrites the
// sanitised HTML string, while proseText walks the pre-sanitisation clone — so
// bodyText legitimately still carries chrome bodyHtml has dropped. Same
// convention as chrome-patterns.test.ts.
async function bodyHtml(html: string): Promise<string> {
  document.body.innerHTML = html;
  const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
  return cap.bodyHtml ?? '';
}

describe('1b — icon-font ligature names', () => {
  it('drops Material Icons ligatures rendered as literal text', async () => {
    // kaggle / playstore: the element's text IS the glyph, so once the icon
    // font is gone the name shows as a word.
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <span>chevron_right</span><i>file_download</i><span>keyboard_arrow_down</span>
        <div>more_vert</div><span>arrow_drop_up</span><i>expand_more</i>
      </article></main>`);
    for (const lig of ['chevron_right', 'file_download', 'keyboard_arrow_down',
      'more_vert', 'arrow_drop_up', 'expand_more']) {
      expect(text, `${lig} is a glyph name, not content`).not.toContain(lig);
    }
  });

  it('keeps snake_case CODE IDENTIFIERS and usernames of the same shape', async () => {
    // The corpus has `static_cast`, `serde_json`, `from_str`, `torsten_dev` in
    // the identical leaf shape, so the affordance vocabulary — not the shape —
    // has to be the discriminator.
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <span>static_cast</span><span>serde_json</span><span>torsten_dev</span>
      </article></main>`);
    for (const id of ['static_cast', 'serde_json', 'torsten_dev']) {
      expect(text, `${id} is real content`).toContain(id);
    }
  });

  it('keeps an affordance-vocabulary name that is inside a code block', async () => {
    // huggingface's `get_current_temperature` is the one corpus token whose
    // FIRST word is in the vocabulary while being a real identifier; the
    // <code>/<pre> ancestor exclusion is what saves it.
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <pre><code><span>get_current_temperature</span></code></pre>
      </article></main>`);
    expect(text).toContain('get_current_temperature');
  });
});

describe('1c — text-to-speech narration players', () => {
  it('drops a "Listen to this article" player', async () => {
    const text = await bodyHtml(`
      <main><article>
        <div><div><span>Listen to this article</span><span>5 min</span></div></div>
        <p>${PROSE}</p>
      </article></main>`);
    expect(text).not.toContain('Listen to this article');
    expect(text, 'the article itself survives').toContain('real body of the article');
  });

  it('leaves the surrounding prose alone when the player sits MID-article', async () => {
    // nbcnews puts its player directly after a paragraph; an unguarded climb
    // took the body with it.
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <div><p>A second paragraph that must survive the removal of the player that follows it right here.</p>
          <div><span>Listen to this article with a </span><span>free profile</span></div></div>
        <p>A third paragraph of genuine article prose that also has to survive intact.</p>
      </article></main>`);
    expect(text).not.toContain('Listen to this article');
    expect(text).toContain('A second paragraph that must survive');
    expect(text).toContain('A third paragraph of genuine article prose');
  });
});

describe('1d — video transport bars built from divs', () => {
  it('drops a control bar with a zeroed position timecode', async () => {
    // cbsnews / nypost build the bar from <div>s and bare <svg>s, so the older
    // span/button pass never counted it. Asserted here with <span>s: under
    // jsdom there is no layout, so capture falls to Readability, which rewrites
    // bare <div>s into <p>s in a tree this pass has already finished with. The
    // div shape is covered live by the corpus sweep.
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <div><span>00:00</span><span>/</span><span>02:00</span></div>
      </article></main>`);
    expect(text).not.toContain('02:00');
  });

  it('keeps a TRACKLIST of durations', async () => {
    // bandcamp has 40 durations and spotify-album a full tracklist; neither
    // ever shows 00:00, which is what the zeroed-position rule keys on.
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <div><span>03:23</span><span>01:36</span><span>00:52</span><span>01:19</span></div>
      </article></main>`);
    for (const d of ['03:23', '01:36', '00:52', '01:19']) {
      expect(text, `${d} is a track duration`).toContain(d);
    }
  });
});

describe('1e — newsletter signup blocks', () => {
  it('drops a signup box identified by its consent tail', async () => {
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <div><div>Top story picks, delivered to your inbox each afternoon.</div>
          <div>SIGN UP</div>
          <div>By signing up, you agree to our Terms of Use and Privacy Policy.</div></div>
      </article></main>`);
    expect(text).not.toContain('By signing up, you agree');
    expect(text).not.toContain('delivered to your inbox');
    expect(text, 'the article itself survives').toContain('real body of the article');
  });

  it('leaves prose alone when the box sits MID-article', async () => {
    const text = await bodyHtml(`
      <main><article>
        <p>${PROSE}</p>
        <div><p>A paragraph of real article prose long enough to count as a body paragraph and not chrome.</p>
          <div><div>Get our Classics newsletter.</div><div>By signing up, you agree to our user agreement.</div></div></div>
        <p>A further paragraph of genuine article prose that must also survive this removal intact.</p>
      </article></main>`);
    expect(text).not.toContain('By signing up, you agree');
    expect(text).toContain('A paragraph of real article prose');
    expect(text).toContain('A further paragraph of genuine article prose');
  });
});
