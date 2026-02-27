// Role: Shared — Nostr event factory
// Description: Builds EventTemplate objects for kind 1 (quote note or resource note)
//              and kind 30078 (encrypted clip). Signing is handled by the background worker;
//              finalizeEventWithPrivateKey is provided only for guest mode / testing.
// Access: nostr-tools/pure (finalizeEvent, event construction helpers)

import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import type { CaptureResult, Evaluation } from '@/shared/types';

/**
 * Create a Note event (Kind 1) for quote captures
 */
export function createQuoteNoteEvent(
  capture: CaptureResult & { type: 'quote' },
  evaluation: Evaluation
): EventTemplate {
  if (capture.type !== 'quote') {
    throw new Error('Invalid capture type for quote note event');
  }

  const content = [
    `Discerned: ${evaluation.interest} / ${evaluation.ethics} — ${evaluation.category}`,
    `> "${capture.content}"`,
    '',
    capture.url,
  ].join('\n');

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags: [
      ['r', capture.url],
      ['L', 'online.discerned.interest'],
      ['L', 'online.discerned.ethics'],
      ['L', 'online.discerned.category'],
      ['l', evaluation.interest, 'online.discerned.interest'],
      ['l', evaluation.ethics, 'online.discerned.ethics'],
      ['l', evaluation.category, 'online.discerned.category'],
      ['t', 'discerned'],
    ],
    content,
  };

  // Preserve raw quote and context as tags for programmatic access
  template.tags.push(['quote', capture.content]);
  if (capture.context) {
    template.tags.push(['context', capture.context]);
  }

  return template;
}

/**
 * Create a Note event (Kind 1) for resource captures
 */
export function createResourceNoteEvent(
  capture: CaptureResult & { type: 'resource' },
  evaluation: Evaluation
): EventTemplate {
  if (capture.type !== 'resource') {
    throw new Error('Invalid capture type for note event');
  }

  // Construct human-readable content
  const content = [
    `Discerned: ${evaluation.interest} / ${evaluation.ethics} — ${evaluation.category}`,
    '',
    capture.title,
    capture.url,
  ].join('\n');

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(capture.timestamp / 1000),
    tags: [
      ['r', capture.url],
      ['L', 'online.discerned.interest'],
      ['L', 'online.discerned.ethics'],
      ['L', 'online.discerned.category'],
      ['l', evaluation.interest, 'online.discerned.interest'],
      ['l', evaluation.ethics, 'online.discerned.ethics'],
      ['l', evaluation.category, 'online.discerned.category'],
      ['t', 'discerned'],
    ],
    content,
  };

  // Add thumbnail if available
  if (capture.thumbnail) {
    template.tags.push(['image', capture.thumbnail]);
  }

  return template;
}

/**
 * Create an encrypted App Data event (Kind 30078) for private clips
 */
export function createEncryptedClipEvent(
  encryptedPayload: string,
  _pubkey: string
): EventTemplate {
  return {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `clip_${Date.now()}`], // Unique identifier for replaceable event
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
  // Check required fields
  if (!event.id || !event.pubkey || !event.sig) {
    return false;
  }

  // Check id is 64 hex chars
  if (!/^[0-9a-f]{64}$/.test(event.id)) {
    return false;
  }

  // Check pubkey is 64 hex chars
  if (!/^[0-9a-f]{64}$/.test(event.pubkey)) {
    return false;
  }

  // Check sig is 128 hex chars
  if (!/^[0-9a-f]{128}$/.test(event.sig)) {
    return false;
  }

  // Check kind is valid integer
  if (!Number.isInteger(event.kind) || event.kind < 0) {
    return false;
  }

  // Check created_at is valid timestamp
  if (!Number.isInteger(event.created_at) || event.created_at < 0) {
    return false;
  }

  // Check tags is array
  if (!Array.isArray(event.tags)) {
    return false;
  }

  // Check content is string
  if (typeof event.content !== 'string') {
    return false;
  }

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
