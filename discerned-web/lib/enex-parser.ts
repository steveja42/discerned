import type { ClipData } from '@/lib/types';

const SAFE_TAGS = new Set(['p', 'br', 'div', 'b', 'i', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'span']);
const STRIP_TAGS = new Set(['en-note', 'en-media', 'en-todo', 'en-crypt']);

function parseEnexDate(raw: string): number {
  // YYYYMMDDTHHMMSSZ → 2023-04-15T14:30:22Z
  try {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
    const ts = new Date(iso).getTime();
    return isNaN(ts) ? Date.now() : ts;
  } catch {
    return Date.now();
  }
}

function getTextContent(el: Element | null): string {
  if (!el) return '';
  return el.textContent?.trim() ?? '';
}

function normalizeEnml(raw: string): string {
  // Strip XML declaration (<?xml ... ?>) and DOCTYPE declaration so DOMParser
  // doesn't reject the string when it appears as a nested document inside CDATA.
  return raw
    .replace(/<\?xml[^?]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>[]*(\[[^\]]*\])?>/gi, '')
    .trim();
}

function enmlToBodyHtml(contentEl: Element | null): string | undefined {
  if (!contentEl) return undefined;
  const raw = normalizeEnml(contentEl.textContent ?? '');
  if (!raw) return undefined;

  // The ENML content is stored as a CDATA string inside <content>
  // Parse it as XML
  const parser = new DOMParser();
  const enDoc = parser.parseFromString(raw, 'text/xml');
  if (enDoc.querySelector('parseerror')) return undefined;

  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (STRIP_TAGS.has(tag)) {
      // Recurse into children of en-note but drop the tag itself; strip others entirely
      if (tag === 'en-note') {
        return Array.from(el.childNodes).map(serializeNode).join('');
      }
      return '';
    }

    if (!SAFE_TAGS.has(tag)) {
      // Unknown tag — render children only
      return Array.from(el.childNodes).map(serializeNode).join('');
    }

    let attrs = '';
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) attrs = ` href="${href.replace(/"/g, '&quot;')}"`;
    }

    const children = Array.from(el.childNodes).map(serializeNode).join('');
    if (tag === 'br') return '<br>';
    return `<${tag}${attrs}>${children}</${tag}>`;
  }

  const html = serializeNode(enDoc.documentElement);
  return html.trim() || undefined;
}

function enmlToBodyText(contentEl: Element | null): string | undefined {
  if (!contentEl) return undefined;
  const raw = normalizeEnml(contentEl.textContent ?? '');
  if (!raw) return undefined;

  const parser = new DOMParser();
  const enDoc = parser.parseFromString(raw, 'text/xml');
  if (enDoc.querySelector('parseerror')) {
    // Fallback: strip all XML tags from the raw string
    return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
  }
  return (enDoc.documentElement.textContent ?? '').trim() || undefined;
}

export function parseEnex(xmlText: string, notebookName: string): ClipData[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');

  if (doc.querySelector('parseerror')) {
    throw new Error('Invalid ENEX file: XML parse error');
  }

  const notes = Array.from(doc.querySelectorAll('note'));
  // Single-note exports don't represent a real notebook, so use General rather
  // than creating a one-off category from the filename.
  const category = notes.length === 1 ? 'General' : (notebookName.trim() || 'General');

  return notes.map((note): ClipData => {
    const title = getTextContent(note.querySelector('title')) || 'Untitled';
    const createdRaw = getTextContent(note.querySelector('created'));
    const timestamp = createdRaw ? parseEnexDate(createdRaw) : Date.now();
    const url = getTextContent(note.querySelector('note-attributes > source-url')) || '';
    const contentEl = note.querySelector('content');

    return {
      capture: {
        id: crypto.randomUUID(),
        format: 'article',
        url,
        title,
        timestamp,
        bodyHtml: enmlToBodyHtml(contentEl),
        bodyText: enmlToBodyText(contentEl),
      },
      evaluation: {
        interest: 'Neutral',
        ethics: 'Neutral',
        category,
      },
      encrypted: '',
    };
  });
}
