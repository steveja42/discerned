// Role: Shared — Nostr event factory
// Description: Builds EventTemplate objects for kind 1 (selection quote, bookmark, or rich-format
//              resource) and kind 30078 (encrypted clip). Signing is handled by the background worker;
//              finalizeEventWithPrivateKey is provided only for guest mode / testing.
// Access: nostr-tools/pure (finalizeEvent, event construction helpers)

import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import type { Capture, Evaluation } from '@/shared/types';
import { signalRank } from '@/shared/types';

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

/**
 * Create a Note event (Kind 1) for selection captures (quoted text inline).
 */
export function createQuoteNoteEvent(
  capture: Capture,
  evaluation: Evaluation
): EventTemplate {
  if (capture.format !== 'selection') {
    throw new Error('createQuoteNoteEvent requires a selection-format capture');
  }

  const quotedText = capture.selectionText ?? '';

  const baseContent = [
    evaluationSummary(evaluation),
    `> "${quotedText}"`,
    '',
    capture.url,
  ].join('\n');

  const tags = baseEvaluationTags(capture, evaluation);
  tags.push(['quote', quotedText]);
  if (capture.selectionContext) {
    tags.push(['context', capture.selectionContext]);
  }

  return {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content: appendNoteToContent(baseContent, capture),
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
  inlineBody?: string
): EventTemplate {
  if (capture.format === 'selection') {
    throw new Error('createResourceNoteEvent does not accept selection format');
  }

  const lines = [
    evaluationSummary(evaluation),
    '',
    capture.title,
    capture.url,
  ];
  if (inlineBody && inlineBody.trim().length > 0) {
    lines.push('', '--- body ---', inlineBody);
  }

  const tags = baseEvaluationTags(capture, evaluation);
  if (capture.title && capture.title.trim().length > 0) {
    tags.push(['title', capture.title]);
  }
  // Cast a real URL as the `image` tag — never a data: URI. Article/full-page
  // captures inline the hero image as base64 (via inlineImage) for the private
  // clip render; publishing that inline adds 50–60 KB and pushes the event past
  // relay 64 KB limits ("event too large"). Prefer the preserved original URL
  // (thumbnailUrl); fall back to `thumbnail` only when it's itself an http(s)
  // URL (the bookmark path stores a raw URL there). Data URIs stay in IndexedDB.
  const imageUrl = capture.thumbnailUrl ?? capture.thumbnail;
  if (imageUrl && /^https?:/i.test(imageUrl)) {
    tags.push(['image', imageUrl]);
  }
  if (inlineBody && inlineBody.trim().length > 0) {
    tags.push(['body', inlineBody]);
  }

  return {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags,
    content: appendNoteToContent(lines.join('\n'), capture),
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
