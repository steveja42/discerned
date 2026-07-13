// Role: Shared — Nostr event factory
// Description: Builds EventTemplate objects for kind 1 (selection quote, bookmark, or rich-format
//              resource), kind 30023 (NIP-23 long-form article), and kind 30078 (encrypted clip).
//              Signing is handled by the background worker; finalizeEventWithPrivateKey is provided
//              only for guest mode / testing.
// Access: nostr-tools/pure (finalizeEvent, event construction helpers), nostr-tools/nip19 (mentions)

import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
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

function appendNoteToContent(content: string, capture: Capture): string {
  if (!capture.note || capture.note.trim().length === 0) return content;
  return `${content}\n\n— ${capture.note}`;
}

// Content images — publish every image as a real URL (never base64) as one
// NIP-92 `imeta` tag per image. Modern clients (Primal/Damus/Nostrudel) render
// a gallery from these tags. We deliberately do NOT append bare image-URL lines
// to the content: the long-form markdown already embeds them as ![](url), and a
// teaser/short note has no room — appending them just produced an ugly wall of
// URLs at the bottom of the cast (and duplicated images whose query-params
// differed from the inline ones).
function appendImageUrls(tags: string[][], _contentLines: string[], capture: Capture): void {
  const urls = (capture.imageUrls ?? []).filter(u => /^https?:/i.test(u));
  for (const u of urls) {
    tags.push(['imeta', `url ${u}`]);
  }
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

// Chars to cap a note's inline body at. Bodies longer than this are teasered.
const NOTE_TEASER_MAX_CHARS = 600;

// Many article extractions include the page's <h1> as the first line of the
// body — which duplicates the note's title line. Drop a leading body line that
// matches the title (case/space/punctuation-insensitive) so the note doesn't
// show the headline twice.
function stripLeadingTitle(bodyText: string | undefined, title: string): string | undefined {
  const body = bodyText?.trim();
  if (!body) return body ?? undefined;
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  const t = norm(title);
  if (!t) return body;
  // Split off the first block (up to the first blank line or first newline).
  const nl = body.indexOf('\n');
  const firstLine = (nl === -1 ? body : body.slice(0, nl)).trim();
  if (norm(firstLine) === t) {
    return body.slice(firstLine.length).replace(/^\s+/, '');
  }
  return body;
}

// A short teaser for a note that links to a companion long-form: the first few
// paragraphs of the plain-text body, capped, ending with an ellipsis. Bare
// image-URL lines (interleaved by proseText) are dropped from the teaser.
function bodyTeaser(bodyText: string | undefined, maxChars = NOTE_TEASER_MAX_CHARS): string | undefined {
  const body = bodyText?.trim();
  if (!body) return undefined;
  const paras = body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0 && !/^https?:\/\/\S+$/i.test(p));
  if (paras.length === 0) return undefined;
  let out = '';
  for (const p of paras) {
    if (out.length > 0 && (out.length + p.length + 2) > maxChars) break;
    out = out.length === 0 ? p : `${out}\n\n${p}`;
    if (out.length >= maxChars) break;
  }
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '');
  return out.length < body.length ? `${out}…` : out;
}

// The path portion of a URL (before '?'), lowercased — for comparing two URLs
// that point at the same image but differ in query params (CDN resize tokens).
function urlBase(u: string): string {
  return u.split('?')[0].toLowerCase();
}

// NIP-23 clients render the `title` and `image` tags as a heading + hero banner
// ABOVE the article body. If the markdown ALSO leads with its own `# title` and
// hero `![](image)`, they show twice. Strip a leading title heading (matching
// the title tag) and a leading hero image (matching the image tag by URL base
// path) from the markdown so the client renders each once, from the tags.
function stripLeadingArticleChrome(markdown: string, title: string, imageUrl?: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  const t = norm(title);
  const imgBase = imageUrl ? urlBase(imageUrl) : '';
  const lines = markdown.split('\n');
  let i = 0;
  // Walk leading blank lines / a title heading / the hero image (in any order,
  // possibly interleaved with blanks), stopping at the first real body line.
  let changed = true;
  while (changed && i < lines.length) {
    changed = false;
    while (i < lines.length && lines[i].trim() === '') { i++; changed = true; }
    if (i >= lines.length) break;
    const line = lines[i];
    // Leading "# Heading" matching the title.
    const h = /^#{1,3}\s+(.*)$/.exec(line.trim());
    if (h && t && norm(h[1]) === t) { i++; changed = true; continue; }
    // Leading hero image ![alt](url [ "title"]) whose URL matches the image tag.
    const img = /^!\[[^\]]*\]\(([^)\s]+)/.exec(line.trim());
    if (img && imgBase && urlBase(img[1]) === imgBase) { i++; changed = true; continue; }
  }
  return lines.slice(i).join('\n').replace(/^\s+/, '');
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

/**
 * The "Discerned → ★★★ Rating in Category · [qualifiers]" snippet prepended to
 * every cast's content. Wrapped in invisible sentinel markers
 * (SNIPPET_SENTINEL_*) so discerned's own web app strips it before rendering,
 * while third-party Nostr clients show the visible line. No author mention — the
 * client already shows the poster.
 */
export function buildDiscernedSnippet(evaluation: Evaluation): string {
  const rating = evaluation.signal
    ? `${'★'.repeat(signalRank(evaluation.signal))} ${evaluation.signal} `
    : '';
  const parts = [`${rating}in ${evaluation.category}`];
  if (evaluation.qualifiers.length > 0) parts.push(`[${evaluation.qualifiers.join(', ')}]`);
  const line = `Discerned → ${parts.join(' · ')}`;
  return `${SNIPPET_SENTINEL_OPEN}${line}${SNIPPET_SENTINEL_CLOSE}`;
}

// The web-app CTA appended to the end of every cast's content, visible in
// third-party Nostr clients. Not sentinel-wrapped — we WANT it shown everywhere,
// including discerned's own feed is fine (it's a harmless self-link).
const DISCERNED_CTA = 'View more discerns at https://discerned.online/discerns';

// Prepend the attribution snippet + append the web-app CTA to event content.
function withSnippet(content: string, snippet?: string): string {
  const withCta = `${content}\n\n${DISCERNED_CTA}`;
  if (!snippet) return withCta;
  return `${snippet}\n\n${withCta}`;
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

  // The snippet carries the rating/category attribution — no "Discerned: …"
  // summary line here.
  const contentLines = [
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

  // Drop a leading body line that just repeats the title (the article's <h1>),
  // so the note doesn't show the headline twice.
  const dedupedBody = stripLeadingTitle(inlineBody, capture.title);

  // The snippet carries the rating/category attribution, so the content no
  // longer repeats a "Discerned: …" summary line. Content: title, url, then a
  // body. With a companion long-form the body is a short TEASER (first few
  // paragraphs) plus a "Read the full article →" link — keeping the note small.
  // Without one, the note inlines the (relay-safe) body as before.
  const body = longFormRef ? bodyTeaser(dedupedBody) : dedupedBody;

  const lines = [
    capture.title,
    capture.url,
  ];
  if (body && body.length > 0) {
    lines.push('', body);
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
  // The `body` tag mirrors the note's inline body for the web app's parser; use
  // the full (title-deduped) inline body when there's no long-form, else omit.
  if (!longFormRef && dedupedBody && dedupedBody.length > 0) {
    tags.push(['body', dedupedBody]);
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
  // No `summary` tag — Nostrudel renders it awkwardly (before our snippet) and
  // clients derive their own preview from the content anyway.
  tags.push(['published_at', String(Math.floor(capture.timestamp / 1000))]);
  const imageUrl = pickImageUrl(capture);
  if (imageUrl) tags.push(['image', imageUrl]);

  // NIP-23 clients render the title + image tags as heading + hero above the
  // body; strip a duplicate leading heading/hero from the markdown so they don't
  // appear twice.
  const dedupedMarkdown = stripLeadingArticleChrome(markdownBody, capture.title, imageUrl);

  const contentLines = withSnippet(dedupedMarkdown, snippet).split('\n');
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
