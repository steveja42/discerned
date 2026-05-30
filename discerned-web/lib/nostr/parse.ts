// Converts a raw Nostr kind:1 event into the app's ClipData shape.
// Discerned events use `l` tags with namespaced values for the three axes
// (online.discerned.interest / ethics / category), `r` for the source URL,
// and `quote` for the clipped selection text.

import type { Event } from 'nostr-tools';
import type { ClipData, ClipFormat, InterestLevel, EthicsLevel } from '@/lib/types';

function getTag(event: Event, tagName: string, namespace?: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === tagName) {
      if (namespace === undefined) return tag[1] ?? null;
      if (tag[2] === namespace) return tag[1] ?? null;
    }
  }
  return null;
}

export function parseEvent(event: Event): ClipData {
  const url = getTag(event, 'r') ?? '';
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
    evaluation: { interest, ethics, category },
    encrypted: '',
  };
}
