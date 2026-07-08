// Single row in the Discernments or Library clip list.
// Derives a deterministic favicon colour from the source domain so each site
// gets a consistent avatar without fetching any external favicon service.

'use client';

import type React from 'react';
import type { ClipData } from '@/lib/types';
import Glyph, { type GlyphVariant } from '@/components/glyph/Glyph';
import { authorLabel, type AuthorProfile } from '@/lib/nostr/profiles';

interface ClipRowProps {
  clip: ClipData;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  glyphVariant?: GlyphVariant;
  author?: AuthorProfile;
  isSelectMode?: boolean;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function favLetter(domain: string): string {
  return domain.charAt(0).toUpperCase();
}

function favColor(domain: string): string {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  const hue = Math.abs(h) % 360;
  return `oklch(0.30 0.08 ${hue})`;
}

export default function ClipRow({
  clip, selected, onClick, glyphVariant = 'bars', author,
  isSelectMode = false, isSelected = false, onSelect,
}: ClipRowProps) {
  const { capture, evaluation } = clip;
  const domain = domainOf(capture.url);
  const caster = capture.authorPubkey ? authorLabel(capture.authorPubkey, author) : null;

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect?.(capture.id);
  };

  return (
    <article
      className={`clip${selected ? ' selected' : ''}${isSelectMode ? ' select-mode' : ''}${isSelected ? ' checked' : ''}`}
      onClick={onClick}
    >
      <span className="clip-checkbox-wrap" onClick={handleCheckboxClick}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => { /* controlled via onClick */ }}
          tabIndex={-1}
        />
      </span>
      <div className="clip-main">
        <div className="clip-source">
          <span className="fav" style={{ background: favColor(domain) }}>{favLetter(domain)}</span>
          <span className="domain">{domain}</span>
          <span className="dot">·</span>
          <span>{formatDate(capture.timestamp)}</span>
          {caster && (
            <>
              <span className="dot">·</span>
              <span className="clip-author" title={caster}>{caster}</span>
            </>
          )}
        </div>
        <Glyph
          interest={evaluation.interest ?? 'Neutral'}
          ethics={evaluation.ethics ?? 'Neutral'}
          category={evaluation.category}
          signal={evaluation.signal}
          qualifiers={evaluation.qualifiers}
          variant={glyphVariant}
        />
        <h3 className="clip-title">{capture.title}</h3>
        {(capture.selectionText || capture.bodyText) && (
          <p className="clip-excerpt">
            {capture.selectionText
              ? capture.selectionText.replace(/<[^>]*>/g, '')
              : capture.bodyText}
          </p>
        )}
        {capture.note && <div className="clip-note">{capture.note}</div>}
      </div>
    </article>
  );
}
