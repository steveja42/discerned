// Converts a raw Nostr kind:1 event into the app's ClipData shape.
// Discerned events use `l` tags with namespaced values — current casts carry
// online.discerned.signal (single, optional) + online.discerned.qualifier
// (repeated) + online.discerned.category; legacy casts carry
// online.discerned.interest / ethics instead. `r` is the source URL and
// `quote` the clipped selection text.

import type { Event } from 'nostr-tools';
import type { ClipData, ClipFormat, InterestLevel, EthicsLevel, SignalLevel } from '@/lib/types';
import { SIGNAL_LEVELS } from '@/lib/constants';

function getTag(event: Event, tagName: string, namespace?: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === tagName) {
      if (namespace === undefined) return tag[1] ?? null;
      if (tag[2] === namespace) return tag[1] ?? null;
    }
  }
  return null;
}

// All values for a repeated namespaced tag (e.g. one `l` per qualifier).
function getTags(event: Event, tagName: string, namespace: string): string[] {
  const values: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === tagName && tag[2] === namespace && tag[1]) values.push(tag[1]);
  }
  return values;
}

export function parseEvent(event: Event): ClipData {
  const url = getTag(event, 'r') ?? '';
  const rawSignal = getTag(event, 'l', 'online.discerned.signal');
  const signal = rawSignal && (SIGNAL_LEVELS as readonly string[]).includes(rawSignal)
    ? (rawSignal as SignalLevel)
    : undefined;
  const qualifiers = getTags(event, 'l', 'online.discerned.qualifier');
  // Legacy axes keep their Neutral defaults so old casts render exactly as before.
  const interest = (getTag(event, 'l', 'online.discerned.interest') ?? 'Neutral') as InterestLevel;
  const ethics = (getTag(event, 'l', 'online.discerned.ethics') ?? 'Neutral') as EthicsLevel;
  const category = getTag(event, 'l', 'online.discerned.category') ?? 'General';
  const format = (getTag(event, 'format') ?? 'bookmark') as ClipFormat;
  const selectionText = getTag(event, 'quote') ?? undefined;
  const selectionContext = getTag(event, 'context') ?? undefined;
  const note = getTag(event, 'note') ?? undefined;
  const bodyText = getTag(event, 'body') ?? undefined;
  const thumbnail = getTag(event, 'image') ?? undefined;

  // Prefer the explicit `title` tag; fall back for legacy casts that lack it.
  // Resource-cast content is "Discerned: …\n\n<title>\n<url>", so line index 2
  // is the title. Selection casts have no title — fall back to the URL.
  const contentTitle = format !== 'selection' ? event.content.split('\n')[2]?.trim() : undefined;
  const title = getTag(event, 'title') ?? contentTitle ?? (url || 'Untitled');

  return {
    capture: {
      id: event.id,
      format,
      url,
      title,
      timestamp: event.created_at * 1000,
      selectionText,
      selectionContext,
      bodyText,
      thumbnail,
      note,
      authorPubkey: event.pubkey,
    },
    evaluation: { signal, qualifiers, interest, ethics, category },
    encrypted: '',
  };
}
