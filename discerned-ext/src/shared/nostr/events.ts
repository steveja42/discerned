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
 * Casts on rich-format clips inline the body in the kind-1 note only when the
 * plain-text body is shorter than this threshold (≈8 KB); longer bodies are
 * truncated there. The full article still goes public via the companion
 * kind-30023 long-form — unless it exceeds LONGFORM_MARKDOWN_MAX_CHARS below.
 *
 * Tuned to leave headroom under typical relay 64 KB event-size limits after
 * tag overhead, signature, and JSON encoding.
 */
export const CAST_INLINE_BODY_MAX_CHARS = 8000;

/**
 * Soft ceiling on the companion long-form markdown — beyond this the event would
 * be too large for relays, so the markdown is truncated to fit. Generous: NIP-23
 * is meant for long content, so real articles effectively never hit this.
 */
export const LONGFORM_MARKDOWN_MAX_CHARS = 400_000;

/**
 * Version stamped as the third element of the NIP-89 `client` tag on every
 * published cast (`['client', 'discerned', '<version>']`). Casts are permanent
 * and public, so this is the only way to know after the fact which capture
 * pipeline produced a given event — invaluable when someone reports a clip that
 * rendered wrong in a third-party client.
 *
 * Injected rather than read from `chrome.runtime.getManifest()` inside this
 * module, for two reasons: this factory is otherwise pure (no `chrome.*`
 * dependency, so it runs under jsdom in Vitest), and the committed golden event
 * fixtures in tests/fixtures/events/ are generated from it — reading the live
 * manifest would rewrite all ~20 of them on every version bump, burying real
 * factory changes in release-diff noise. Tests therefore see the stable
 * placeholder below; the real version is set once at background startup.
 */
export const DEFAULT_CLIENT_VERSION = '0.0.0-dev';
let clientVersion: string = DEFAULT_CLIENT_VERSION;

/**
 * Set the version stamped on the `client` tag. Called once from the background
 * worker with `chrome.runtime.getManifest().version`.
 */
export function setClientVersion(version: string): void {
  const v = version.trim();
  if (v.length > 0) clientVersion = v;
}

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
  // NIP-89 allows extra positional elements on `client`; the third is the
  // version. Clients that only read tag[1] are unaffected.
  tags.push(
    ['t', 'discerned'],
    ['format', capture.format],
    ['client', 'discerned', clientVersion]
  );
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

// Is this capture a tweet (twitter.com / x.com status page)? For tweets, X's
// page <title> *is* the tweet text ("<name> on X: \"<body>\""), which the note's
// author+text body already carries — so the note omits the title line to avoid
// showing the tweet text twice. The `title` TAG is kept (clients/web-app use it
// for the card heading).
function isTweetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com';
  } catch {
    return false;
  }
}

// Does the markdown embed this image (as ![alt](url)) anywhere? Compared by URL
// base path so a CDN query-param delta between the `image` tag and the inline
// occurrence doesn't defeat the match.
function markdownEmbedsImage(markdown: string, imageUrl: string): boolean {
  const base = urlBase(imageUrl);
  const re = /!\[[^\]]*\]\(([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    if (urlBase(m[1]) === base) return true;
  }
  return false;
}

// Does the markdown embed ANY image (![alt](url)) at all? Used to tell a text-only
// article (no body images → the og:image is a legit hero worth banner-ing) from an
// article that already carries its own imagery (→ an og:image not among them is a
// social-share card, not the article's visual lead, so don't add it as a hero).
function markdownHasAnyImage(markdown: string): boolean {
  return /!\[[^\]]*\]\([^)\s]+/.test(markdown);
}

// Does the markdown LEAD with an image — i.e. an ![alt](url) appears at the top,
// before any real prose? Article/full-page captures put the hero first, so a
// leading inline image IS the hero. We can't reliably URL-match it to the `image`
// tag (the inline copy is often a base64 data URI, or a different-resolution crop
// of the same photo — e.g. Breitbart's 640x335 tag vs 640x480 inline), so a
// leading image means "the body already carries the hero" regardless of URL, and
// the `image` tag banner must be suppressed to avoid showing it twice.
function markdownLeadsWithImage(markdown: string): boolean {
  const lines = markdown.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    // A heading (the title) may precede the hero — skip it and keep looking.
    if (/^#{1,3}\s+/.test(line)) continue;
    // First non-blank, non-heading line: is it an image?
    return /^!\[[^\]]*\]\([^)\s]+/.test(line);
  }
  return false;
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
  //
  // Tweets are the exception: they're short (no teasering needed) AND their body
  // interleaves image URLs as their own paragraphs so the web app renders them
  // inline in position — bodyTeaser DROPS bare-image-URL paragraphs (line "Bare
  // image-URL lines … dropped"), which would gut a tweet's media. So tweets keep
  // the full body regardless of the long-form ref.
  const isTweet = isTweetUrl(capture.url);
  const body = (longFormRef && !isTweet) ? bodyTeaser(dedupedBody) : dedupedBody;

  // For a tweet, X's page <title> IS the tweet text ("<name> on X: \"<body>\""),
  // which `body` already carries as "<name> @<handle>\n<text>" — so omit the
  // title CONTENT line to avoid showing the tweet text twice. The `title` TAG is
  // still emitted below (clients/web-app render the card heading from it).
  const omitTitleLine = isTweet && !!body && body.length > 0;

  const lines = omitTitleLine ? [capture.url] : [capture.title, capture.url];
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

  // NIP-23 clients render the title + image tags as heading + hero above the
  // body; strip a duplicate LEADING heading/hero from the markdown so they don't
  // appear twice.
  const dedupedMarkdown = stripLeadingArticleChrome(markdownBody, capture.title, imageUrl);

  // Emit the `image` tag (rendered as a banner ABOVE the body by clients) only
  // when it's a genuine hero the reader would expect at the top. Suppress it when:
  //  - the body already embeds the SAME image URL (markdownEmbedsImage), or
  //  - the body LEADS with an image (markdownLeadsWithImage) whose URL we can't
  //    match to the tag because the inline copy is a base64 data URI or a
  //    different-resolution crop of the same photo (the Breitbart case) — a leading
  //    image is the hero regardless of URL, so the banner would duplicate it, or
  //  - the body already carries its OWN imagery, none of it matching the tag
  //    (markdownHasAnyImage but not markdownEmbedsImage). Then the `image` URL is a
  //    social-share card (og:image) that appears NOWHERE in the article the reader
  //    saw — Substack's og:image is a generated share graphic, not the lead photo —
  //    so banner-ing it prepends a phantom hero. Only when the body has NO images of
  //    its own is the og:image a legit hero (a text article whose lead the extractor
  //    dropped), and the banner is kept.
  if (
    imageUrl &&
    !markdownEmbedsImage(dedupedMarkdown, imageUrl) &&
    !markdownLeadsWithImage(dedupedMarkdown) &&
    !markdownHasAnyImage(dedupedMarkdown)
  ) {
    tags.push(['image', imageUrl]);
  }

  const contentLines = withSnippet(dedupedMarkdown, snippet).split('\n');
  appendImageUrls(tags, contentLines, capture);

  return {
    kind: 30023,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content: contentLines.join('\n'),
  };
}

// NOTE: there is deliberately no kind-0 (profile metadata) factory here. Kind-0
// is replaceable, so publishing one erases every field it omits from the relays.
// discerned doesn't manage profiles — that belongs in a client with real
// name/about/picture editing. See the note in background.ts near signEvent.

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
 * Build a NIP-02 kind-3 contact-list event that adds or removes exactly one
 * `p` tag. `currentTags`/`currentContent` MUST be the user's existing kind-3
 * event fetched fresh immediately before calling this (see
 * background/follow-list-fetcher.ts) — kind:3 is fully-replaceable, same
 * hazard as kind:0 above: publishing from a stale or reconstructed tag list
 * would silently erase the rest of the user's contacts. `content` is passed
 * through unchanged since legacy clients store a relay-list JSON blob there.
 */
export function buildFollowListEvent(
  currentTags: string[][],
  currentContent: string,
  mutation: { add: string } | { remove: string }
): EventTemplate {
  let tags: string[][];
  if ('add' in mutation) {
    const already = currentTags.some((t) => t[0] === 'p' && t[1] === mutation.add);
    tags = already ? currentTags : [...currentTags, ['p', mutation.add]];
  } else {
    tags = currentTags.filter((t) => !(t[0] === 'p' && t[1] === mutation.remove));
  }
  return {
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: currentContent,
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
