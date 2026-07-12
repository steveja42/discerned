// Role: Shared — Nostr event factory
// Description: Builds EventTemplate objects for kind 1 (selection quote, bookmark, or rich-format
//              resource), kind 30023 (NIP-23 long-form article), and kind 30078 (encrypted clip).
//              Signing is handled by the background worker; finalizeEventWithPrivateKey is provided
//              only for guest mode / testing.
// Access: nostr-tools/pure (finalizeEvent, event construction helpers), nostr-tools/nip19 (mentions)

import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';
import type { Capture, Evaluation } from '@/shared/types';
import { signalRank, SNIPPET_SENTINEL_OPEN, SNIPPET_SENTINEL_CLOSE } from '@/shared/types';

/**
 * Casts on rich-format clips inline the body in the event content only when the
 * plain-text body is shorter than this threshold (≈8 KB). Longer bodies cast as
 * URL-summary only — full content stays in the user's IndexedDB.
 *
 * Tuned to leave headroom under typical relay 64 KB event-size limits after
 * tag overhead, signature, and JSON encoding.
 */
export const CAST_INLINE_BODY_MAX_CHARS = 8000;

function baseEvaluationTags(capture: Capture, evaluation: Evaluation): string[][] {
  const tags: string[][] = [
    ['r', capture.url],
    ['L', 'online.discerned.category'],
    ['l', evaluation.category, 'online.discerned.category'],
  ];
  if (evaluation.signal) {
    tags.push(['L', 'online.discerned.signal']);
    tags.push(['l', evaluation.signal, 'online.discerned.signal']);
  }
  if (evaluation.qualifiers.length > 0) {
    tags.push(['L', 'online.discerned.qualifier']);
    for (const q of evaluation.qualifiers) {
      tags.push(['l', q, 'online.discerned.qualifier']);
    }
  }
  tags.push(['t', 'discerned'], ['format', capture.format], ['client', 'discerned']);
  if (capture.note && capture.note.trim().length > 0) {
    tags.push(['note', capture.note]);
  }
  return tags;
}

// First content line, e.g. "Discerned: ★★★★ Worthwhile — Philosophy";
// unrated clips carry just "Discerned: Philosophy".
function evaluationSummary(evaluation: Evaluation): string {
  if (!evaluation.signal) return `Discerned: ${evaluation.category}`;
  return `Discerned: ${'★'.repeat(signalRank(evaluation.signal))} ${evaluation.signal} — ${evaluation.category}`;
}

function appendNoteToContent(content: string, capture: Capture): string {
  if (!capture.note || capture.note.trim().length === 0) return content;
  return `${content}\n\n— ${capture.note}`;
}

// Content images — publish every image as a real URL (never base64). Emit one
// NIP-92 `imeta` tag per image for modern clients (Primal/Damus render a
// gallery). Article bodies already carry the URLs interleaved at their
// in-article positions (proseText), so clients that auto-embed image URLs in
// text render them in place; only URLs NOT already in the content (tweet
// casts, selections, bodies truncated past a URL) get appended at the end.
function appendImageUrls(tags: string[][], contentLines: string[], capture: Capture): void {
  const urls = (capture.imageUrls ?? []).filter(u => /^https?:/i.test(u));
  if (urls.length === 0) return;
  for (const u of urls) {
    tags.push(['imeta', `url ${u}`]);
  }
  const existing = contentLines.join('\n');
  const missing = urls.filter(u => !existing.includes(u));
  if (missing.length > 0) contentLines.push('', ...missing);
}

// First http(s) image URL to cast as the `image` tag — never a data: URI (they
// are too large for relays). Prefer the preserved original thumbnail URL, then a
// `thumbnail` that is itself an http(s) URL (the bookmark path stores one there),
// then the first content image. Shared by the resource and long-form factories.
function pickImageUrl(capture: Capture): string | undefined {
  return [capture.thumbnailUrl, capture.thumbnail, ...(capture.imageUrls ?? [])]
    .find((u): u is string => !!u && /^https?:/i.test(u));
}

// A reference to a companion kind-30023 long-form event, used to turn the
// kind-1 note into a "summary + link to the full article" instead of inlining
// the body. `coord` is the NIP-33 'a'-tag coordinate `30023:<pubkey>:<d>`;
// `naddr` is the NIP-19 bech32 for the human-readable link line.
export interface LongFormRef {
  coord: string;
  naddr: string;
  relay?: string;
}

// Add the 'a'-tag + a "Read the full article →" link line when a companion
// long-form exists. The naddr link lets Nostr clients resolve the article.
function appendLongFormRef(tags: string[][], contentLines: string[], ref?: LongFormRef): void {
  if (!ref) return;
  tags.push(ref.relay ? ['a', ref.coord, ref.relay] : ['a', ref.coord]);
  contentLines.push('', `Read the full article → nostr:${ref.naddr}`);
}

/**
 * The sanitised HTML to convert to markdown for a long-form (kind-30023) body.
 * Article/full-page carry it in bodyHtml; selections carry it (sanitised, with
 * images already inlined) in selectionText. Bookmarks have no body → undefined.
 */
export function sourceHtmlForLongForm(capture: Capture): string | undefined {
  if (capture.format === 'article' || capture.format === 'full-page') {
    return capture.bodyHtml?.trim() || undefined;
  }
  if (capture.format === 'selection') {
    return capture.selectionText?.trim() || undefined;
  }
  return undefined;
}

// A short summary for the NIP-23 `summary` tag: the user's own note when present
// (their gloss is the best summary), else a word-boundary prefix of the body.
export function deriveSummary(capture: Capture, maxChars = 300): string | undefined {
  const note = capture.note?.trim();
  if (note) return note.length > maxChars ? note.slice(0, maxChars).replace(/\s+\S*$/, '') + '…' : note;
  const body = capture.bodyText?.trim();
  if (!body) return undefined;
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}

/**
 * The "Discerned by …" attribution snippet prepended to every cast's content.
 * Wrapped in invisible sentinel markers (SNIPPET_SENTINEL_*) so discerned's own
 * web app strips it before rendering, while third-party Nostr clients show the
 * visible line. `authorPubkey` is the casting user's hex pubkey (or undefined
 * when not yet known — the mention is then omitted, never blocking the cast).
 * `relays` seed the nprofile mention so clients can find the author.
 */
export function buildDiscernedSnippet(
  evaluation: Evaluation,
  authorPubkey?: string,
  relays: readonly string[] = []
): string {
  const parts: string[] = ['Discerned by'];
  if (authorPubkey) {
    let mention: string;
    try {
      mention = relays.length > 0
        ? nprofileEncode({ pubkey: authorPubkey, relays: relays.slice(0, 2) as string[] })
        : npubEncode(authorPubkey);
    } catch {
      mention = '';
    }
    if (mention) parts.push(`nostr:${mention}`);
  }
  const meta: string[] = [];
  if (evaluation.signal) {
    meta.push(`${'★'.repeat(signalRank(evaluation.signal))} ${evaluation.signal}`);
  }
  meta.push(evaluation.category);
  if (evaluation.qualifiers.length > 0) meta.push(`[${evaluation.qualifiers.join(', ')}]`);
  const line = `${parts.join(' ')} — ${meta.join(' · ')}`;
  return `${SNIPPET_SENTINEL_OPEN}${line}${SNIPPET_SENTINEL_CLOSE}`;
}

// Prepend the attribution snippet to event content when one is supplied.
function withSnippet(content: string, snippet?: string): string {
  if (!snippet) return content;
  return `${snippet}\n\n${content}`;
}

/**
 * Create a Note event (Kind 1) for selection captures (quoted text inline).
 * `snippet` (optional) is the "Discerned by …" attribution prepended to content.
 */
export function createQuoteNoteEvent(
  capture: Capture,
  evaluation: Evaluation,
  snippet?: string,
  longFormRef?: LongFormRef
): EventTemplate {
  if (capture.format !== 'selection') {
    throw new Error('createQuoteNoteEvent requires a selection-format capture');
  }

  const quotedText = capture.selectionText ?? '';

  const contentLines = [
    evaluationSummary(evaluation),
    `> "${quotedText}"`,
    '',
    capture.url,
  ];

  const tags = baseEvaluationTags(capture, evaluation);
  tags.push(['quote', quotedText]);
  if (capture.selectionContext) {
    tags.push(['context', capture.selectionContext]);
  }
  appendImageUrls(tags, contentLines, capture);
  appendLongFormRef(tags, contentLines, longFormRef);

  return {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content: withSnippet(appendNoteToContent(contentLines.join('\n'), capture), snippet),
  };
}

/**
 * Create a Note event (Kind 1) for bookmark / article / full-page captures.
 *
 * For rich formats (article / full-page), the caller may pass `inlineBody`
 * (plain text) when the body is small enough to fit safely on relays. When omitted (or for
 * bookmark format) the event publishes URL-summary only — full body stays in IndexedDB.
 */
export function createResourceNoteEvent(
  capture: Capture,
  evaluation: Evaluation,
  inlineBody?: string,
  snippet?: string,
  longFormRef?: LongFormRef
): EventTemplate {
  if (capture.format === 'selection') {
    throw new Error('createResourceNoteEvent does not accept selection format');
  }

  // The note stays self-sufficient — it inlines the body as before (when short
  // enough for relays). A companion long-form, when present, is ALSO linked via
  // an `a` tag + a "Read the full article" line (appendLongFormRef) so long-form
  // clients can open the full NIP-23 article, but the note is never gutted.
  const inline = inlineBody;

  const lines = [
    evaluationSummary(evaluation),
    '',
    capture.title,
    capture.url,
  ];
  if (inline && inline.trim().length > 0) {
    lines.push('', '--- body ---', inline);
  }

  const tags = baseEvaluationTags(capture, evaluation);
  if (capture.title && capture.title.trim().length > 0) {
    tags.push(['title', capture.title]);
  }
  // Cast a real URL as the `image` tag — never a data: URI. Article/full-page
  // captures inline the hero image as base64 for the private clip render;
  // publishing that inline pushes the event past relay 64 KB limits. Data URIs
  // stay in IndexedDB. (See pickImageUrl.)
  const imageUrl = pickImageUrl(capture);
  if (imageUrl) {
    tags.push(['image', imageUrl]);
  }
  if (inline && inline.trim().length > 0) {
    tags.push(['body', inline]);
  }

  const contentLines = [...lines];
  appendImageUrls(tags, contentLines, capture);
  appendLongFormRef(tags, contentLines, longFormRef);

  return {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content: withSnippet(appendNoteToContent(contentLines.join('\n'), capture), snippet),
  };
}

/**
 * Create a NIP-23 long-form article event (Kind 30023) for article / full-page
 * captures, or for selections that carry real formatting. `markdownBody` is the
 * capture HTML converted to markdown (see html-to-markdown.ts); it is NOT
 * truncated — the whole point of 30023 is the full article. `snippet` (optional)
 * is the "Discerned by …" attribution prepended to content.
 *
 * kind-30023 is a parameterized-replaceable event: the required `d` tag is the
 * stable Capture.id, so re-casting the same clip replaces (not duplicates) it.
 */
export function createLongFormEvent(
  capture: Capture,
  evaluation: Evaluation,
  markdownBody: string,
  snippet?: string
): EventTemplate {
  if (capture.format === 'bookmark') {
    throw new Error('createLongFormEvent does not accept bookmark format');
  }

  const tags = baseEvaluationTags(capture, evaluation);
  tags.push(['d', capture.id]);
  if (capture.title && capture.title.trim().length > 0) {
    tags.push(['title', capture.title]);
  }
  const summary = deriveSummary(capture);
  if (summary) tags.push(['summary', summary]);
  tags.push(['published_at', String(Math.floor(capture.timestamp / 1000))]);
  const imageUrl = pickImageUrl(capture);
  if (imageUrl) tags.push(['image', imageUrl]);

  const contentLines = withSnippet(markdownBody, snippet).split('\n');
  appendImageUrls(tags, contentLines, capture);

  return {
    kind: 30023,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content: contentLines.join('\n'),
  };
}

export interface ProfileMetadata {
  name?: string;
  nip05?: string;
  about?: string;
  picture?: string;
}

/**
 * Create a Profile Metadata event (Kind 0). Used to publish the user's
 * NIP-05 identifier (and display name) so any Nostr client can verify
 * `name@discerned.online` against their pubkey.
 */
export function createProfileEvent(meta: ProfileMetadata): EventTemplate {
  return {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['client', 'discerned']],
    content: JSON.stringify(meta),
  };
}

/**
 * Create an encrypted App Data event (Kind 30078) for private clips.
 * Tags are public — keep them minimal (no format/url leaks). The `d` tag matches the
 * Capture's stable `id` so the user's own client can correlate IndexedDB rows with
 * relay-synced replaceable events.
 */
export function createEncryptedClipEvent(
  capture: Capture,
  encryptedPayload: string
): EventTemplate {
  return {
    kind: 30078,
    created_at: Math.floor(capture.timestamp / 1000),
    tags: [
      ['d', capture.id],
      ['client', 'discerned'],
    ],
    content: encryptedPayload,
  };
}

/**
 * Finalize an event template with signature
 * (for guest mode or testing - real signing should use NIP-07/46)
 */
export function finalizeEventWithPrivateKey(
  template: EventTemplate,
  privateKey: Uint8Array
): NostrEvent {
  return finalizeEvent(template, privateKey);
}

/**
 * Validate a Nostr event structure
 */
export function validateEvent(event: NostrEvent): boolean {
  if (!event.id || !event.pubkey || !event.sig) return false;
  if (!/^[0-9a-f]{64}$/.test(event.id)) return false;
  if (!/^[0-9a-f]{64}$/.test(event.pubkey)) return false;
  if (!/^[0-9a-f]{128}$/.test(event.sig)) return false;
  if (!Number.isInteger(event.kind) || event.kind < 0) return false;
  if (!Number.isInteger(event.created_at) || event.created_at < 0) return false;
  if (!Array.isArray(event.tags)) return false;
  if (typeof event.content !== 'string') return false;
  return true;
}

/**
 * Extract metadata from tags
 */
export function extractTagValue(event: NostrEvent, tagName: string): string | null {
  const tag = event.tags.find(t => t[0] === tagName);
  return tag ? tag[1] : null;
}

/**
 * Get all values for a tag type
 */
export function extractTagValues(event: NostrEvent, tagName: string): string[] {
  return event.tags
    .filter(t => t[0] === tagName)
    .map(t => t[1])
    .filter(Boolean);
}
