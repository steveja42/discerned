// Converts a raw Nostr kind:1 event into the app's ClipData shape.
// Discerned events use `l` tags with namespaced values: online.discerned.signal
// (single, optional) + online.discerned.qualifier (repeated) +
// online.discerned.category. `r` is the source URL and `quote` the clipped
// selection text.

import type { Event } from 'nostr-tools';
import type { ClipData, ClipFormat, SignalLevel } from '@/lib/types';
import { SIGNAL_LEVELS } from '@/lib/constants';
import { stripDiscernedCta, stripDiscernedSnippet } from './strip-snippet';

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

// NIP-92 imeta tags: ["imeta", "url <URL>", "m <mime>", …]. Pull the URL out
// of each. Discerned casts emit one imeta per content image.
function getImetaUrls(event: Event): string[] {
  const urls: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'imeta') continue;
    for (const field of tag.slice(1)) {
      const m = /^url\s+(\S+)/.exec(field);
      if (m && /^https?:/i.test(m[1])) { urls.push(m[1]); break; }
    }
  }
  return urls;
}

export function parseEvent(event: Event): ClipData {
  const url = getTag(event, 'r') ?? '';
  const rawSignal = getTag(event, 'l', 'online.discerned.signal');
  const signal = rawSignal && (SIGNAL_LEVELS as readonly string[]).includes(rawSignal)
    ? (rawSignal as SignalLevel)
    : undefined;
  const qualifiers = getTags(event, 'l', 'online.discerned.qualifier');
  const category = getTag(event, 'l', 'online.discerned.category') ?? 'General';
  const format = (getTag(event, 'format') ?? 'bookmark') as ClipFormat;
  const note = getTag(event, 'note') ?? undefined;
  const thumbnail = getTag(event, 'image') ?? undefined;
  const imageUrls = getImetaUrls(event);
  // Strip the attribution snippet and the trailing web-app CTA before touching
  // content — neither must reach the UI, and (for kind-1) the snippet would
  // shift the line-index title fallback.
  const content = stripDiscernedCta(stripDiscernedSnippet(event.content));

  if (event.kind === 30023) {
    // NIP-23 long-form: content is markdown; d is the source clip id; the
    // published_at tag carries the original capture time (seconds).
    const publishedAt = Number(getTag(event, 'published_at'));
    const timestamp = Number.isFinite(publishedAt) && publishedAt > 0
      ? publishedAt * 1000
      : event.created_at * 1000;
    const title = getTag(event, 'title') ?? (url || 'Untitled');
    return {
      capture: {
        id: event.id,
        kind: 30023,
        format,
        url,
        title,
        timestamp,
        summary: getTag(event, 'summary') ?? undefined,
        markdown: content,
        longFormId: getTag(event, 'd') ?? undefined,
        thumbnail,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        note,
        authorPubkey: event.pubkey,
      },
      evaluation: { signal, qualifiers, category },
      encrypted: '',
    };
  }

  // kind 1 (note)
  const selectionText = getTag(event, 'quote') ?? undefined;
  const selectionContext = getTag(event, 'context') ?? undefined;
  const bodyText = getTag(event, 'body') ?? undefined;
  // A summary+link note references its companion long-form via an 'a' tag
  // (30023:<pubkey>:<d>). Expose the <d> as longFormId so the feed can dedup the
  // pair, preferring the richer 30023.
  const aTag = getTag(event, 'a');
  const longFormId = aTag?.startsWith('30023:') ? aTag.split(':')[2] : undefined;

  // Prefer the explicit `title` tag (present on all current casts). Fall back
  // for legacy/tagless casts: current resource-cast content (after snippet
  // strip) is "<title>\n<url>\n\n<body>" (line 0 = title); older casts led with
  // a "Discerned: …\n\n<title>\n<url>" summary (line 2 = title). Try both, skip
  // a "Discerned:" line, and never treat the URL as the title.
  let contentTitle: string | undefined;
  if (format !== 'selection') {
    const lines = content.split('\n').map((l) => l.trim());
    const first = lines[0] ?? '';
    const candidate = first.startsWith('Discerned:') ? lines[2] : first;
    contentTitle = candidate && candidate !== url ? candidate : undefined;
  }
  const title = getTag(event, 'title') ?? contentTitle ?? (url || 'Untitled');

  return {
    capture: {
      id: event.id,
      kind: 1,
      format,
      url,
      title,
      timestamp: event.created_at * 1000,
      selectionText,
      selectionContext,
      bodyText,
      longFormId,
      thumbnail,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      note,
      authorPubkey: event.pubkey,
    },
    evaluation: { signal, qualifiers, category },
    encrypted: '',
  };
}
