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
