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

  const title = event.content.split('\n')[0]?.slice(0, 120) || url || 'Untitled';

  return {
    capture: {
      id: event.id,
      format,
      url,
      title,
      timestamp: event.created_at * 1000,
      selectionText,
      note: event.content.includes('\n') ? event.content.split('\n').slice(1).join('\n').trim() || undefined : undefined,
    },
    evaluation: { interest, ethics, category },
    encrypted: '',
  };
}
