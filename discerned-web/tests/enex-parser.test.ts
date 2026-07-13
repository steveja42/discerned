// Evernote ENEX import: multi-note parsing, ENML→safe-HTML conversion, date
// handling, and the single-note category rule. This feeds user data straight
// into the library, so malformed input must fail loudly, and unsafe ENML tags
// must never reach bodyHtml.

import { describe, it, expect } from 'vitest';
import { parseEnex } from '@/lib/enex-parser';

function enexDoc(notes: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20240101T000000Z" application="Evernote" version="10.0">
${notes}
</en-export>`;
}

function note(title: string, opts: { created?: string; url?: string; enml?: string } = {}): string {
  const enml = opts.enml ??
    '<en-note><div>Plain body text.</div></en-note>';
  const content = `<![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
${enml}]]>`;
  return `<note>
  <title>${title}</title>
  <created>${opts.created ?? '20230415T143022Z'}</created>
  <content>${content}</content>
  <note-attributes>${opts.url ? `<source-url>${opts.url}</source-url>` : ''}</note-attributes>
</note>`;
}

describe('parseEnex', () => {
  it('parses a multi-note export with title, url, timestamp, and the notebook category', () => {
    const xml = enexDoc(
      note('First Note', { url: 'https://example.com/a', created: '20230415T143022Z' }) +
      note('Second Note'),
    );
    const clips = parseEnex(xml, 'Reading List');

    expect(clips).toHaveLength(2);
    expect(clips[0].capture.title).toBe('First Note');
    expect(clips[0].capture.url).toBe('https://example.com/a');
    expect(clips[0].capture.timestamp).toBe(Date.parse('2023-04-15T14:30:22Z'));
    expect(clips[0].capture.format).toBe('article');
    // Multi-note exports adopt the notebook name as category.
    expect(clips[0].evaluation.category).toBe('Reading List');
    expect(clips[1].evaluation.category).toBe('Reading List');
    // Each import gets a fresh unique id.
    expect(clips[0].capture.id).not.toBe(clips[1].capture.id);
  });

  it('uses General for single-note exports instead of a one-off category', () => {
    const clips = parseEnex(enexDoc(note('Solo')), 'Some Filename');
    expect(clips).toHaveLength(1);
    expect(clips[0].evaluation.category).toBe('General');
  });

  it('converts ENML to safe HTML: keeps whitelisted tags + href, strips en-media and unknown tags', () => {
    const enml = `<en-note>
      <h1>Heading</h1>
      <p>Para with <a href="https://example.com/x?a=1&amp;b=2">a link</a> and <strong>bold</strong>.</p>
      <en-media hash="abc" type="image/png"></en-media>
      <table><tr><td>cell text survives without the table tags</td></tr></table>
    </en-note>`;
    const [clip] = parseEnex(enexDoc(note('Rich', { enml })), 'NB');
    const html = clip.capture.bodyHtml ?? '';

    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('href="https://example.com/x?a=1&b=2"');
    expect(html).toContain('<strong>bold</strong>');
    // en-media is dropped wholesale; unknown tags unwrap to their children.
    expect(html).not.toContain('en-media');
    expect(html).not.toContain('<table');
    expect(html).toContain('cell text survives');
    // bodyText is the flattened text.
    expect(clip.capture.bodyText).toContain('Para with a link and bold.');
  });

  it('falls back to now for unparseable created dates', () => {
    const before = Date.now();
    const [clip] = parseEnex(enexDoc(note('BadDate', { created: 'garbage' })), 'NB');
    expect(clip.capture.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('defaults the title to Untitled when missing', () => {
    const xml = enexDoc('<note><created>20230415T143022Z</created></note>');
    const [clip] = parseEnex(xml, 'NB');
    expect(clip.capture.title).toBe('Untitled');
  });

  it('throws on a file that is not valid XML', () => {
    expect(() => parseEnex('this is not xml <en-export', 'NB')).toThrow(/Invalid ENEX/i);
  });
});
