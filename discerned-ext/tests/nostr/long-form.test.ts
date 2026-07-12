import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLongFormEvent,
  createResourceNoteEvent,
  createQuoteNoteEvent,
  buildDiscernedSnippet,
  deriveSummary,
  sourceHtmlForLongForm,
  finalizeEventWithPrivateKey,
  validateEvent,
  extractTagValue,
  type LongFormRef,
} from '@/shared/nostr/events';
import { htmlToMarkdown } from '@/content/html-to-markdown';
import { SNIPPET_SENTINEL_OPEN, SNIPPET_SENTINEL_CLOSE } from '@/shared/types';
import type { Capture, Evaluation } from '@/shared/types';

const CLIPS_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'clips');

function loadFixture(pred: (c: Capture) => boolean): { capture: Capture; evaluation: Evaluation } {
  for (const file of readdirSync(CLIPS_ROOT).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(resolve(CLIPS_ROOT, file), 'utf8')) as
      { capture: Capture; evaluation: Evaluation };
    if (pred(data.capture)) return data;
  }
  throw new Error('no matching clip fixture');
}

const DETERMINISTIC_SK = new Uint8Array(32).fill(0x01);
// npub of the all-0x01 key, hex pubkey for the mention.
const PUBKEY_HEX = '4646ae5047316b4230d0086c8acec687f00b1cd9d1dc634f6cb358ac0a9a8fff';
const RELAYS = ['wss://relay.example.com', 'wss://relay2.example.com'];

const artFx = loadFixture((c) => c.format === 'article');

describe('createLongFormEvent (kind 30023)', () => {
  const LONG_MD = '# Heading\n\n' + 'Paragraph text. '.repeat(200);

  it('signs into a valid kind:30023 event with the required d tag', () => {
    const template = createLongFormEvent(artFx.capture, artFx.evaluation, LONG_MD);
    const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
    expect(validateEvent(ev)).toBe(true);
    expect(ev.kind).toBe(30023);
    expect(extractTagValue(ev, 'd')).toBe(artFx.capture.id);
  });

  it('emits title, summary, published_at and discerned axis tags', () => {
    const capture: Capture = { ...artFx.capture, note: 'A concise gloss.' };
    const template = createLongFormEvent(capture, artFx.evaluation, LONG_MD);
    const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
    expect(extractTagValue(ev, 'title')).toBe(capture.title);
    expect(extractTagValue(ev, 'summary')).toBe('A concise gloss.');
    expect(extractTagValue(ev, 'published_at')).toBe(String(Math.floor(capture.timestamp / 1000)));
    // discerned axes ride along via baseEvaluationTags
    expect(extractTagValue(ev, 'r')).toBe(capture.url);
    expect(extractTagValue(ev, 't')).toBe('discerned');
    expect(extractTagValue(ev, 'client')).toBe('discerned');
  });

  it('carries the full untruncated markdown in content', () => {
    const body = LONG_MD + '\n\nEND_OF_ARTICLE_MARKER';
    const template = createLongFormEvent(artFx.capture, artFx.evaluation, body);
    expect(template.content).toContain('END_OF_ARTICLE_MARKER');
    expect(template.content.length).toBeGreaterThanOrEqual(body.length);
  });

  it('prepends the sentinel-wrapped snippet when supplied', () => {
    const snippet = buildDiscernedSnippet(artFx.evaluation, PUBKEY_HEX, RELAYS);
    const template = createLongFormEvent(artFx.capture, artFx.evaluation, LONG_MD, snippet);
    expect(template.content.startsWith(SNIPPET_SENTINEL_OPEN)).toBe(true);
    expect(template.content).toContain(SNIPPET_SENTINEL_CLOSE);
    expect(template.content).toContain('# Heading');
  });

  it('throws for bookmark captures', () => {
    const bookmark: Capture = { ...artFx.capture, format: 'bookmark' };
    expect(() => createLongFormEvent(bookmark, artFx.evaluation, LONG_MD)).toThrow();
  });
});

describe('buildDiscernedSnippet', () => {
  it('includes a nostr: mention when the pubkey is known', () => {
    const s = buildDiscernedSnippet(artFx.evaluation, PUBKEY_HEX, RELAYS);
    expect(s).toContain('Discerned by nostr:');
    expect(s.startsWith(SNIPPET_SENTINEL_OPEN)).toBe(true);
    expect(s.endsWith(SNIPPET_SENTINEL_CLOSE)).toBe(true);
  });

  it('omits the mention gracefully when the pubkey is unknown', () => {
    const s = buildDiscernedSnippet(artFx.evaluation, undefined, RELAYS);
    expect(s).toContain('Discerned by');
    expect(s).not.toContain('nostr:');
    expect(s).toContain(artFx.evaluation.category);
  });

  it('includes the signal only when set', () => {
    const rated = buildDiscernedSnippet({ ...artFx.evaluation, signal: 'Worthwhile' }, PUBKEY_HEX);
    expect(rated).toContain('Worthwhile');
    const unrated = buildDiscernedSnippet({ ...artFx.evaluation, signal: undefined }, PUBKEY_HEX);
    expect(unrated).not.toContain('★');
  });

  it('lists qualifiers when present', () => {
    const s = buildDiscernedSnippet(
      { ...artFx.evaluation, qualifiers: ['Primary Source', 'Timeless'] },
      PUBKEY_HEX,
    );
    expect(s).toContain('[Primary Source, Timeless]');
  });
});

describe('deriveSummary', () => {
  it('prefers the note', () => {
    expect(deriveSummary({ ...artFx.capture, note: 'my note' })).toBe('my note');
  });
  it('falls back to a body prefix', () => {
    const body = 'word '.repeat(200).trim();
    const s = deriveSummary({ ...artFx.capture, note: undefined, bodyText: body }, 100);
    expect(s!.length).toBeLessThanOrEqual(101);
    expect(s!.endsWith('…')).toBe(true);
  });
  it('returns undefined with no note and no body', () => {
    expect(deriveSummary({ ...artFx.capture, note: undefined, bodyText: undefined })).toBeUndefined();
  });
});

describe('htmlToMarkdown (turndown)', () => {
  const html = [
    '<h2>Title</h2>',
    '<p>Intro paragraph with a <a href="https://example.com/link">link</a>.</p>',
    '<ul><li>First</li><li>Second</li></ul>',
    '<img src="https://cdn.example.com/photo.jpg" alt="a photo">',
    '<img src="data:image/png;base64,AAAABBBBCCCC">',
    '<div class="dx-stats"><span>❤ 12</span><span>🔁 3</span></div>',
  ].join('');

  it('preserves headings, lists, links and http images', () => {
    const md = htmlToMarkdown(html);
    expect(md).toContain('## Title');
    expect(md).toContain('[link](https://example.com/link)');
    // turndown pads list items (e.g. "-   First"); match the bullet + text loosely.
    expect(md).toMatch(/-\s+First/);
    expect(md).toMatch(/-\s+Second/);
    expect(md).toContain('![a photo](https://cdn.example.com/photo.jpg)');
  });

  it('drops data: images and dx-* chrome rows', () => {
    const md = htmlToMarkdown(html);
    expect(md).not.toContain('data:image');
    expect(md).not.toContain('❤');
    expect(md).not.toContain('🔁');
  });

  // The capture pipeline inlines images as base64 in `src` but preserves the
  // real URL in `data-dx-src`. The converter must emit ![](realurl) inline, not
  // drop the image (which would dump the URL at the bottom via appendImageUrls).
  it('restores the real URL from data-dx-src for inlined base64 images', () => {
    const inlined = '<p>Body</p><img src="data:image/jpeg;base64,AAAA" data-dx-src="https://cdn.example.com/hero.jpg" alt="hero"><p>More</p>';
    const md = htmlToMarkdown(inlined);
    expect(md).toContain('![hero](https://cdn.example.com/hero.jpg)');
    expect(md).not.toContain('data:image');
    // The image sits inline between the paragraphs, not at the end.
    expect(md.indexOf('hero.jpg')).toBeLessThan(md.indexOf('More'));
  });

  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('sourceHtmlForLongForm', () => {
  it('uses bodyHtml for article/full-page', () => {
    const c: Capture = { ...artFx.capture, bodyHtml: '<p>hi</p>' };
    expect(sourceHtmlForLongForm(c)).toBe('<p>hi</p>');
  });
  it('uses selectionText for selections', () => {
    const c: Capture = { ...artFx.capture, format: 'selection', selectionText: '<p>sel</p>' };
    expect(sourceHtmlForLongForm(c)).toBe('<p>sel</p>');
  });
  it('returns undefined for bookmarks', () => {
    expect(sourceHtmlForLongForm({ ...artFx.capture, format: 'bookmark' })).toBeUndefined();
  });
});

describe('kind-1 note becomes summary + link with a longFormRef', () => {
  const ref: LongFormRef = {
    coord: `30023:${PUBKEY_HEX}:${artFx.capture.id}`,
    naddr: 'naddr1exampleexampleexample',
    relay: RELAYS[0],
  };

  it('emits the a-tag + link line while KEEPING the inline body (note stays self-sufficient)', () => {
    const capture: Capture = { ...artFx.capture, bodyText: 'This is the full article body text.' };
    const snippet = buildDiscernedSnippet(artFx.evaluation, PUBKEY_HEX, RELAYS);
    const template = createResourceNoteEvent(capture, artFx.evaluation, capture.bodyText, snippet, ref);
    const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
    expect(extractTagValue(ev, 'a')).toBe(ref.coord);
    expect(ev.content).toContain(`nostr:${ref.naddr}`);
    expect(ev.content).toContain('Read the full article');
    // The note keeps its readable body AND links to the long-form.
    expect(ev.content).toContain('--- body ---');
    expect(extractTagValue(ev, 'body')).toBe('This is the full article body text.');
    // Snippet still leads the content.
    expect(ev.content.startsWith(SNIPPET_SENTINEL_OPEN)).toBe(true);
  });

  it('selection note also supports the longFormRef + snippet', () => {
    const selFx = loadFixture((c) => c.format === 'selection');
    const snippet = buildDiscernedSnippet(selFx.evaluation, PUBKEY_HEX, RELAYS);
    const template = createQuoteNoteEvent(selFx.capture, selFx.evaluation, snippet, ref);
    const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
    expect(extractTagValue(ev, 'a')).toBe(ref.coord);
    expect(ev.content).toContain('Read the full article');
    expect(ev.content.startsWith(SNIPPET_SENTINEL_OPEN)).toBe(true);
  });
});
