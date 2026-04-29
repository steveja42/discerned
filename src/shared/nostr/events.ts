// Role: Shared — Nostr event factory
// Description: Builds EventTemplate objects for kind 1 (selection quote, bookmark, or rich-format
//              resource) and kind 30078 (encrypted clip). Signing is handled by the background worker;
//              finalizeEventWithPrivateKey is provided only for guest mode / testing.
// Access: nostr-tools/pure (finalizeEvent, event construction helpers)

import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import type { Capture, Evaluation } from '@/shared/types';

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
    ['L', 'online.discerned.interest'],
    ['L', 'online.discerned.ethics'],
    ['L', 'online.discerned.category'],
    ['l', evaluation.interest, 'online.discerned.interest'],
    ['l', evaluation.ethics, 'online.discerned.ethics'],
    ['l', evaluation.category, 'online.discerned.category'],
    ['t', 'discerned'],
    ['format', capture.format],
    ['client', 'discerned'],
  ];
  if (capture.note && capture.note.trim().length > 0) {
    tags.push(['note', capture.note]);
  }
  return tags;
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
    `Discerned: ${evaluation.interest} / ${evaluation.ethics} — ${evaluation.category}`,
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
 * Create a Note event (Kind 1) for bookmark / article / simplified-article / full-page captures.
 *
 * For rich formats (article / simplified-article / full-page), the caller may pass `inlineBody`
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
    `Discerned: ${evaluation.interest} / ${evaluation.ethics} — ${evaluation.category}`,
    '',
    capture.title,
    capture.url,
  ];
  if (inlineBody && inlineBody.trim().length > 0) {
    lines.push('', '--- body ---', inlineBody);
  }

  const tags = baseEvaluationTags(capture, evaluation);
  if (capture.thumbnail) {
    tags.push(['image', capture.thumbnail]);
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
