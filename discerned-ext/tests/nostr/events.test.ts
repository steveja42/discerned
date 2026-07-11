import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createQuoteNoteEvent,
  createResourceNoteEvent,
  finalizeEventWithPrivateKey,
  validateEvent,
  extractTagValue,
  extractTagValues,
} from '@/shared/nostr/events';
import type { Capture, Evaluation, ClipFormat } from '@/shared/types';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';

const CLIPS_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'clips');

interface ClipFixture {
  name: string;
  capture: Capture;
  evaluation: Evaluation;
}

const fixtures: ClipFixture[] = readdirSync(CLIPS_ROOT)
  .filter((f) => f.endsWith('.json'))
  .map((file) => {
    const data = JSON.parse(readFileSync(resolve(CLIPS_ROOT, file), 'utf8')) as
      { capture: Capture; evaluation: Evaluation };
    return { name: file, ...data };
  });

// Deterministic 32-byte secret key so signatures are reproducible across runs.
const DETERMINISTIC_SK = new Uint8Array(32).fill(0x01);

function buildTemplate(capture: Capture, evaluation: Evaluation): EventTemplate {
  if (capture.format === 'selection') return createQuoteNoteEvent(capture, evaluation);
  return createResourceNoteEvent(capture, evaluation, capture.bodyText);
}

describe('Nostr event factory', () => {
  for (const fx of fixtures) {
    describe(`fixture: ${fx.name}`, () => {
      let event: NostrEvent;

      it('signs into a valid kind:1 event', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        event = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
        expect(validateEvent(event)).toBe(true);
        expect(event.kind).toBe(1);
      });

      it('emits the canonical Discerned tags', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);

        // Required tags
        expect(extractTagValue(ev, 'r')).toBe(fx.capture.url);
        expect(extractTagValue(ev, 't')).toBe('discerned');
        expect(extractTagValue(ev, 'client')).toBe('discerned');
        expect(extractTagValue(ev, 'format')).toBe(fx.capture.format satisfies ClipFormat);

        // Category is always labeled; signal and qualifier namespaces appear
        // only when the evaluation carries them (unrated → absent entirely).
        const lTags = ev.tags.filter((t) => t[0] === 'l');
        const LDeclarations = extractTagValues(ev, 'L');

        const categoryTag = lTags.find((t) => t[2] === 'online.discerned.category');
        expect(categoryTag?.[1]).toBe(fx.evaluation.category);
        expect(LDeclarations).toContain('online.discerned.category');

        const signalTag = lTags.find((t) => t[2] === 'online.discerned.signal');
        if (fx.evaluation.signal) {
          expect(signalTag?.[1]).toBe(fx.evaluation.signal);
          expect(LDeclarations).toContain('online.discerned.signal');
        } else {
          expect(signalTag).toBeUndefined();
          expect(LDeclarations).not.toContain('online.discerned.signal');
        }

        const qualifierValues = lTags
          .filter((t) => t[2] === 'online.discerned.qualifier')
          .map((t) => t[1]);
        expect(qualifierValues).toEqual(fx.evaluation.qualifiers);
        if (fx.evaluation.qualifiers.length > 0) {
          expect(LDeclarations).toContain('online.discerned.qualifier');
        } else {
          expect(LDeclarations).not.toContain('online.discerned.qualifier');
        }
      });

      it('leads content with the evaluation summary line', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const firstLine = template.content.split('\n')[0];
        if (fx.evaluation.signal) {
          const rank = ['Toxic', 'Noise', 'Passable', 'Worthwhile', 'Masterpiece']
            .indexOf(fx.evaluation.signal) + 1;
          expect(firstLine).toBe(
            `Discerned: ${'★'.repeat(rank)} ${fx.evaluation.signal} — ${fx.evaluation.category}`,
          );
        } else {
          expect(firstLine).toBe(`Discerned: ${fx.evaluation.category}`);
        }
      });

      it('emits format-specific tags', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);

        if (fx.capture.format === 'selection') {
          expect(extractTagValue(ev, 'quote')).toBe(fx.capture.selectionText ?? '');
          if (fx.capture.selectionContext) {
            expect(extractTagValue(ev, 'context')).toBe(fx.capture.selectionContext);
          }
        } else {
          if (fx.capture.title && fx.capture.title.trim().length > 0) {
            expect(extractTagValue(ev, 'title')).toBe(fx.capture.title);
          }
          // The `image` tag carries a real URL only. A data: URI thumbnail
          // (inlined hero image) is NOT published — it would blow past relay
          // 64 KB limits. thumbnailUrl wins; thumbnail is used only if http(s).
          const expectedImage = fx.capture.thumbnailUrl
            ?? (fx.capture.thumbnail && /^https?:/i.test(fx.capture.thumbnail)
              ? fx.capture.thumbnail
              : null);
          if (expectedImage) {
            expect(extractTagValue(ev, 'image')).toBe(expectedImage);
          }
          if (fx.capture.bodyText) {
            // body tag exists only when caller passed an inlineBody; we always do for tests.
            expect(extractTagValue(ev, 'body')).toBe(fx.capture.bodyText);
          }
        }

        if (fx.capture.note && fx.capture.note.trim().length > 0) {
          expect(extractTagValue(ev, 'note')).toBe(fx.capture.note);
        }
      });

      it('preserves capture.timestamp on the event (seconds resolution)', () => {
        const template = buildTemplate(fx.capture, fx.evaluation);
        const ev = finalizeEventWithPrivateKey(template, DETERMINISTIC_SK);
        expect(ev.created_at).toBe(Math.floor(fx.capture.timestamp / 1000));
      });
    });
  }

  it('rejects createQuoteNoteEvent on non-selection captures', () => {
    const article = fixtures.find((f) => f.capture.format === 'article');
    if (!article) throw new Error('no article fixture');
    expect(() => createQuoteNoteEvent(article.capture, article.evaluation)).toThrow();
  });

  it('rejects createResourceNoteEvent on selection captures', () => {
    const sel = fixtures.find((f) => f.capture.format === 'selection');
    if (!sel) throw new Error('no selection fixture');
    expect(() => createResourceNoteEvent(sel.capture, sel.evaluation)).toThrow();
  });

  // Regression: an inlined hero image (data: URI) once got cast as the `image`
  // tag, producing 60+ KB events that relays reject as "event too large".
  describe('image tag never carries a data: URI (event-size guard)', () => {
    const artFx = fixtures.find((f) => f.capture.format === 'article');
    if (!artFx) throw new Error('no article fixture');

    const dataUri = 'data:image/png;base64,' + 'A'.repeat(80_000);

    it('drops a data: URI thumbnail with no thumbnailUrl fallback', () => {
      const capture: Capture = { ...artFx.capture, thumbnail: dataUri, thumbnailUrl: null };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation),
        DETERMINISTIC_SK,
      );
      expect(extractTagValue(ev, 'image')).toBeNull();
      // The whole event stays comfortably under the 64 KB relay ceiling.
      expect(JSON.stringify(ev).length).toBeLessThan(64_000);
    });

    it('casts the original thumbnailUrl when the thumbnail is inlined', () => {
      const capture: Capture = {
        ...artFx.capture,
        thumbnail: dataUri,
        thumbnailUrl: 'https://example.com/og/hero.jpg',
      };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation),
        DETERMINISTIC_SK,
      );
      expect(extractTagValue(ev, 'image')).toBe('https://example.com/og/hero.jpg');
    });
  });

  // Casts publish every content image as a real URL — one NIP-92 imeta tag per
  // image AND the URLs appended to the note content — never base64.
  describe('capture images cast as imeta tags + content URLs', () => {
    const artFx = fixtures.find((f) => f.capture.format === 'article');
    if (!artFx) throw new Error('no article fixture');

    const photos = [
      'https://pbs.twimg.com/media/AAA?format=webp&name=medium',
      'https://pbs.twimg.com/media/BBB?format=webp&name=medium',
      'https://pbs.twimg.com/media/CCC?format=webp&name=medium',
    ];

    it('emits one imeta tag per image and lists the URLs in content', () => {
      const capture: Capture = {
        ...artFx.capture,
        thumbnailUrl: photos[0],
        imageUrls: photos,
      };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation),
        DETERMINISTIC_SK,
      );
      // One imeta tag per image, each carrying "url <URL>".
      const imeta = extractTagValues(ev, 'imeta');
      expect(imeta).toEqual(photos.map((u) => `url ${u}`));
      // Every URL also present in the visible content for auto-embedding clients.
      for (const u of photos) expect(ev.content).toContain(u);
      // First image doubles as the legacy image tag.
      expect(extractTagValue(ev, 'image')).toBe(photos[0]);
    });

    it('never inlines a data: URI as an imeta url (event-size guard)', () => {
      const capture: Capture = {
        ...artFx.capture,
        imageUrls: ['data:image/webp;base64,' + 'A'.repeat(40_000), photos[1]],
      };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation),
        DETERMINISTIC_SK,
      );
      const imeta = extractTagValues(ev, 'imeta');
      expect(imeta).toEqual([`url ${photos[1]}`]);
      expect(JSON.stringify(ev)).not.toContain('data:image');
    });

    it('adds no imeta tags when there are no content images', () => {
      const capture: Capture = { ...artFx.capture, imageUrls: undefined };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation),
        DETERMINISTIC_SK,
      );
      expect(extractTagValues(ev, 'imeta')).toEqual([]);
    });

    it('does not re-append URLs already interleaved in the inline body', () => {
      const interleavedBody = `First paragraph of the article.\n\n${photos[0]}\n\nSecond paragraph after the image.\n\n${photos[1]}`;
      const capture: Capture = {
        ...artFx.capture,
        bodyText: interleavedBody,
        imageUrls: [photos[0], photos[1], photos[2]],
      };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation, interleavedBody),
        DETERMINISTIC_SK,
      );
      // All three still get imeta tags.
      expect(extractTagValues(ev, 'imeta')).toEqual(photos.map((u) => `url ${u}`));
      // Interleaved URLs appear exactly once (in place, not duplicated at the
      // end); the URL missing from the body is appended.
      expect(ev.content.split(photos[0]).length - 1).toBe(1);
      expect(ev.content.split(photos[1]).length - 1).toBe(1);
      expect(ev.content.split(photos[2]).length - 1).toBe(1);
      expect(ev.content.indexOf(photos[2])).toBeGreaterThan(ev.content.indexOf('Second paragraph'));
    });

    it('falls back to imageUrls[0] for the image tag when there is no thumbnail', () => {
      const capture: Capture = {
        ...artFx.capture,
        thumbnail: null,
        thumbnailUrl: null,
        imageUrls: photos,
      };
      const ev = finalizeEventWithPrivateKey(
        createResourceNoteEvent(capture, artFx.evaluation),
        DETERMINISTIC_SK,
      );
      expect(extractTagValue(ev, 'image')).toBe(photos[0]);
    });

    it('selection casts publish imageUrls as imeta tags + content URLs too', () => {
      const selFx = fixtures.find((f) => f.capture.format === 'selection');
      if (!selFx) throw new Error('no selection fixture');
      const capture: Capture = {
        ...selFx.capture,
        imageUrls: ['data:image/webp;base64,' + 'A'.repeat(40_000), ...photos.slice(0, 2)],
      };
      const ev = finalizeEventWithPrivateKey(
        createQuoteNoteEvent(capture, selFx.evaluation),
        DETERMINISTIC_SK,
      );
      const imeta = extractTagValues(ev, 'imeta');
      expect(imeta).toEqual(photos.slice(0, 2).map((u) => `url ${u}`));
      for (const u of photos.slice(0, 2)) expect(ev.content).toContain(u);
      // The quoted text still leads the content, before the appended URLs.
      expect(ev.content.indexOf('> "')).toBeLessThan(ev.content.indexOf(photos[0]));
      expect(JSON.stringify(ev)).not.toContain('data:image');
    });
  });
});
