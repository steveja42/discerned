// Generates cross-package event-template fixtures from the REAL event factory.
//
// The web app's parse tests used to hand-mirror the extension's event format —
// which silently drifted when the format changed (the "Discerned: …" summary
// line era). Instead, this test builds an EventTemplate for every clip fixture
// via the actual factory functions and writes them (write-if-changed) to
// tests/fixtures/events/*.json at the monorepo root. discerned-web's
// parse.test.ts signs and parses those templates, so any factory change is
// exercised against the real parser on the next `pnpm test`.
//
// The files are committed to git: regenerate by running this suite
// (`pnpm test` in discerned-ext), then commit the diff alongside the factory
// change. Templates are deterministic (no signatures — the web side signs with
// its own throwaway key), so unchanged factories produce zero churn.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import {
  createQuoteNoteEvent,
  createResourceNoteEvent,
  createLongFormEvent,
  buildDiscernedSnippet,
  type LongFormRef,
} from '@/shared/nostr/events';
import { htmlToMarkdown } from '@/content/html-to-markdown';
import type { Capture, Evaluation } from '@/shared/types';
import type { EventTemplate } from 'nostr-tools/core';

const CLIPS_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'clips');
const EVENTS_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'events');

// Placeholder pubkey inside the 'a'-tag coordinate. The web test only checks
// that the <d> segment round-trips; the pubkey segment is never validated.
const REF_PUBKEY = 'f'.repeat(64);

interface GeneratedEventFixture {
  $comment: string;
  source: string;
  variant: 'kind1' | 'kind1-longform-ref' | 'kind30023';
  capture: Capture;
  evaluation: Evaluation;
  longFormRef?: LongFormRef;
  template: EventTemplate;
}

function loadClips(): Array<{ name: string; capture: Capture; evaluation: Evaluation }> {
  return readdirSync(CLIPS_ROOT)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const data = JSON.parse(readFileSync(resolve(CLIPS_ROOT, file), 'utf8')) as
        { capture: Capture; evaluation: Evaluation };
      return { name: basename(file, '.json'), ...data };
    });
}

// Rich-card fixtures: the kind-30023 body is the REAL htmlToMarkdown conversion
// of representative capture bodyHtml (tweet-card, primal note-card, article with
// an inline image). These exercise the exact conversion path that shipped the
// 2026-07-13 cast-rendering bugs — the plain-text clip fixtures above never
// touch htmlToMarkdown. discerned-web's cast-render e2e loads these and renders
// them through the real feed. `image` (thumbnail) is set so DetailPanel's
// hero-suppression logic is exercised (the image is also inline in the body).
interface CardFixture { slug: string; title: string; url: string; heroUrl: string; bodyHtml: string }

const CARD_FIXTURES: CardFixture[] = [
  {
    slug: 'tweet-card',
    title: 'CIA on X: "Havana, Cuba"',
    url: 'https://x.com/CIA/status/2055074954375254084',
    heroUrl: 'https://pbs.twimg.com/poster.jpg',
    bodyHtml: `<div class="tweet-card tweet-card--native">
  <div class="tweet-header">
    <img class="tweet-avatar" src="data:image/png;base64,AAAA" alt="CIA" width="48" height="48" data-dx-src="https://pbs.twimg.com/avatar.jpg">
    <div class="tweet-author"><span class="tweet-name">CIA</span><span class="tweet-handle">@CIA</span></div>
  </div>
  <div class="tweet-text">Havana, Cuba</div>
  <a class="tweet-video" href="https://x.com/CIA/status/2055074954375254084" style="max-width:100%">
    <img src="data:image/jpeg;base64,BBBB" alt="Video thumbnail" class="tweet-video-poster" data-dx-src="https://pbs.twimg.com/poster.jpg">
    <div class="tweet-video-play" aria-label="Play video"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
    <span class="tweet-video-duration">0:47</span>
  </a>
  <div class="tweet-footer"><a class="tweet-date" href="https://x.com/CIA/status/2055074954375254084">11:57 PM · May 14, 2026</a><span class="tweet-date">4.1M Views</span><span class="tweet-stats"><span class="tweet-stat" aria-label="Reply"><svg><path/></svg><span class="tweet-stat-count">1.3K</span></span><span class="tweet-stat" aria-label="Like"><svg><path/></svg><span class="tweet-stat-count">43K</span></span></span></div>
</div>`,
  },
  {
    slug: 'primal-note',
    title: 'Gigi on primal.net',
    url: 'https://primal.net/e/note1',
    heroUrl: '',
    bodyHtml: `<div class="dx-post">
  <div class="dx-header"><img alt="avatar" src="data:image/png;base64,AAAA" width="42" height="42" data-dx-src="https://r2.primal.net/avatar.jpg"><span>Gigi</span></div>
  <div>Terrible idea. Harmful concept. Users will get rekt, attacked, or worse.</div>
  <a class="dx-quote" href="https://primal.net/e/note2">
    <div class="dx-header"><img alt="avatar" src="data:image/png;base64,BBBB" width="26" height="26" data-dx-src="https://r2.primal.net/vitor.jpg"><span>Vitor Pamplona</span></div>
    <div>The concept of a public wallet is very interesting and we need to explore more.</div>
  </a>
  <div class="dx-stats"><div><div>8</div></div><div><div>528</div></div><div><div>62</div></div></div>
</div>`,
  },
  {
    slug: 'article-inline-img',
    title: 'Your Home Server Deserves Better',
    url: 'https://example.com/home-server',
    heroUrl: 'https://cdn.example.com/hero.jpg',
    bodyHtml: `<article>
  <p>Your home server deserves better than hand-me-down hardware.</p>
  <img src="data:image/jpeg;base64,CCCC" alt="server rack" data-dx-src="https://cdn.example.com/hero.jpg">
  <p>Treating it like a spare PC means spare-PC reliability: no ECC, no redundancy.</p>
</article>`,
  },
];

function buildCardFixtures(comment: string): GeneratedEventFixture[] {
  const out: GeneratedEventFixture[] = [];
  const evaluation: Evaluation = { signal: 'Worthwhile', qualifiers: [], category: 'General' } as unknown as Evaluation;
  const ts = 1_700_000_000_000;
  for (const cf of CARD_FIXTURES) {
    const markdown = htmlToMarkdown(cf.bodyHtml);
    const capture: Capture = {
      id: `card-${cf.slug}`,
      format: 'full-page',
      url: cf.url,
      title: cf.title,
      timestamp: ts,
      bodyHtml: cf.bodyHtml,
      thumbnailUrl: cf.heroUrl || null,
    } as unknown as Capture;
    const snippet = buildDiscernedSnippet(evaluation);
    out.push({
      $comment: comment, source: `card-${cf.slug}`, variant: 'kind30023',
      capture, evaluation,
      template: createLongFormEvent(capture, evaluation, markdown, snippet),
    });
  }
  return out;
}

function buildFixtures(): GeneratedEventFixture[] {
  const out: GeneratedEventFixture[] = [];
  const comment =
    'GENERATED by discerned-ext/tests/nostr/event-fixture-generation.test.ts — do not edit by hand.';

  for (const { name, capture, evaluation } of loadClips()) {
    const snippet = buildDiscernedSnippet(evaluation);

    // Plain kind-1 cast — the shape handleCast publishes when no long-form
    // companion exists.
    const kind1 =
      capture.format === 'selection'
        ? createQuoteNoteEvent(capture, evaluation, snippet)
        : createResourceNoteEvent(capture, evaluation, capture.bodyText, snippet);
    out.push({ $comment: comment, source: `${name}.json`, variant: 'kind1', capture, evaluation, template: kind1 });

    // Rich formats also publish a kind-30023 companion + a summary-and-link
    // kind-1 that references it. Emit both variants for those.
    if (capture.format === 'article' || capture.format === 'full-page' || capture.format === 'selection') {
      const ref: LongFormRef = {
        coord: `30023:${REF_PUBKEY}:${capture.id}`,
        naddr: 'naddr1generatedfixtureexample',
        relay: 'wss://relay.example.com',
      };
      const kind1Ref =
        capture.format === 'selection'
          ? createQuoteNoteEvent(capture, evaluation, snippet, ref)
          : createResourceNoteEvent(capture, evaluation, capture.bodyText, snippet, ref);
      out.push({
        $comment: comment, source: `${name}.json`, variant: 'kind1-longform-ref',
        capture, evaluation, longFormRef: ref, template: kind1Ref,
      });

      // Long-form markdown body: the real pipeline converts bodyHtml via
      // turndown; clip fixtures carry plain text, which is valid markdown.
      const markdown = `# ${capture.title}\n\n${capture.bodyText ?? capture.selectionText ?? 'Body.'}`;
      out.push({
        $comment: comment, source: `${name}.json`, variant: 'kind30023',
        capture, evaluation,
        template: createLongFormEvent(capture, evaluation, markdown, snippet),
      });
    }
  }
  out.push(...buildCardFixtures(comment));
  return out;
}

describe('event-template fixture generation (cross-package contract)', () => {
  it('writes one template per clip fixture + long-form variants', () => {
    const fixtures = buildFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    mkdirSync(EVENTS_ROOT, { recursive: true });

    let written = 0;
    for (const fx of fixtures) {
      const file = resolve(EVENTS_ROOT, `${fx.source.replace(/\.json$/, '')}.${fx.variant}.json`);
      const next = JSON.stringify(fx, null, 2) + '\n';
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (prev !== next) {
        writeFileSync(file, next, 'utf8');
        written++;
      }
    }
    // Informational only — a change here means the factory output changed and
    // the regenerated fixtures should be committed with it.
    // eslint-disable-next-line no-console
    if (written > 0) console.log(`[event-fixtures] regenerated ${written}/${fixtures.length} template fixture(s) in tests/fixtures/events/`);

    // Every template must be a valid unsigned event shape.
    for (const fx of fixtures) {
      expect(fx.template.kind === 1 || fx.template.kind === 30023).toBe(true);
      expect(fx.template.created_at).toBe(Math.floor(fx.capture.timestamp / 1000));
      expect(Array.isArray(fx.template.tags)).toBe(true);
      expect(typeof fx.template.content).toBe('string');
    }
  });
});
