// Strips the "Discerned by …" attribution snippet from a cast's content.
//
// Every discerned cast (kind-1 note and kind-30023 long-form) prepends a
// human-readable attribution line so THIRD-PARTY Nostr clients show it. In
// discerned's own feed we don't want it — we render those axes from `l` tags via
// the glyph UI — so we strip the whole block by its invisible sentinel markers.
//
// The sentinels are PURELY INVISIBLE runs of invisible-math codepoints and are
// MIRRORED from the extension's shared/types.ts (SNIPPET_SENTINEL_OPEN /
// _CLOSE). If you change them, change BOTH — like DEFAULT_RELAYS.

export const SNIPPET_SENTINEL_OPEN = '⁣⁡⁢⁣';  // U+2063 U+2061 U+2062 U+2063
export const SNIPPET_SENTINEL_CLOSE = '⁢⁡⁣⁢'; // U+2062 U+2061 U+2063 U+2062

// Escape a string for use as a literal in a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove the sentinel-wrapped attribution block (and the blank line the writer
// inserts after it) from content. Idempotent; a no-op when no sentinel present
// (legacy casts / non-discerned events).
export function stripDiscernedSnippet(content: string): string {
  if (!content.includes(SNIPPET_SENTINEL_OPEN)) return content;
  const pattern = new RegExp(
    `${escapeRegExp(SNIPPET_SENTINEL_OPEN)}[\\s\\S]*?${escapeRegExp(SNIPPET_SENTINEL_CLOSE)}\\n{0,2}`,
    'g',
  );
  return content.replace(pattern, '').trimStart();
}

// The self-link CTA the extension appends to every cast's content, MIRRORED from
// the extension's shared/nostr/events.ts (DISCERNED_CTA). It exists so
// THIRD-PARTY Nostr clients carry a pointer back to the web app; in discerned's
// own feed it's noise pointing at the page the reader is already on, so we strip
// it here for the same reason we strip the attribution snippet.
//
// Unlike the snippet it is deliberately NOT sentinel-wrapped (other clients must
// see it as ordinary text), so this matches it literally — only at the very end
// of the content, where the writer puts it.
const DISCERNED_CTA = 'View more discerns at https://discerned.online/discerns';

// Remove the trailing web-app CTA. Idempotent; a no-op when absent (legacy casts
// / non-discerned events), and it never touches a mid-body occurrence — the
// writer only ever appends it.
export function stripDiscernedCta(content: string): string {
  const pattern = new RegExp(`\\n{0,2}${escapeRegExp(DISCERNED_CTA)}\\s*$`);
  return content.replace(pattern, '');
}
