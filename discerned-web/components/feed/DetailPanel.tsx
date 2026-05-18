// Right-rail detail panel — renders the selected clip's full excerpt, axis track bars,
// category swatch, and action buttons. Shows a placeholder when no clip is selected.

'use client';

import { useState, useEffect } from 'react';
import type { ClipData } from '@/lib/types';
import { CATEGORIES, interestRank, ethicsRank } from '@/lib/constants';
import Wedge from '@/components/glyph/Wedge';

interface DetailPanelProps {
  clip: ClipData | null;
  onDelete: (id: string) => void;
  onUpdateNote: (id: string, note: string) => void;
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

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function NoteEditor({
  note,
  clipId,
  onUpdateNote,
}: {
  note: string | undefined;
  clipId: string;
  onUpdateNote: (id: string, note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? '');

  // Reset when clip changes.
  useEffect(() => {
    setEditing(false);
    setDraft(note ?? '');
  }, [clipId, note]);

  const save = () => {
    onUpdateNote(clipId, draft);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(note ?? '');
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="note-edit-area">
        <textarea
          className="note-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            if (e.key === 'Escape') cancel();
          }}
        />
        <div className="note-edit-actions">
          <button className="btn-note-save" onClick={save}>Save</button>
          <button className="btn-note-cancel" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  if (note) {
    return (
      <div className="note-display" onClick={() => { setDraft(note); setEditing(true); }}>
        <p style={{ margin: 0, fontFamily: 'var(--sans)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)' }}>
          {note}
        </p>
        <button className="note-edit-trigger" title="Edit note" aria-label="Edit note">✎</button>
      </div>
    );
  }

  return (
    <span
      className="note-add-prompt"
      onClick={() => { setDraft(''); setEditing(true); }}
    >
      Add a note…
    </span>
  );
}

export default function DetailPanel({ clip, onDelete, onUpdateNote }: DetailPanelProps) {
  if (!clip) {
    return (
      <aside className="detail">
        <div className="detail-empty">
          <div className="glyph-big">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
            </svg>
          </div>
          <p>Select a clip to read its excerpt, ratings, and who else has discerned it.</p>
        </div>
      </aside>
    );
  }

  const { capture, evaluation } = clip;
  const domain = domainOf(capture.url);
  const cat = CATEGORIES[evaluation.category] ?? { label: evaluation.category, hue: 60 };
  const iIdx = interestRank(evaluation.interest);
  const eIdx = ethicsRank(evaluation.ethics);
  const iNeutral = iIdx === 1;
  const eNeutral = eIdx === 2;
  const showAssessment = !iNeutral || !eNeutral;

  return (
    <aside className="detail">
      <div className="detail-head">
        <div className="detail-source">
          <span className="fav" style={{ background: favColor(domain) }}>{favLetter(domain)}</span>
          <span className="domain">{domain}</span>
          <a
            href={capture.url}
            target="_blank"
            rel="noopener noreferrer"
            className="detail-url"
            title={capture.url}
          >
            {capture.url}
          </a>
          <span className="detail-byline">{formatDate(capture.timestamp)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <h2 className="detail-title" style={{ flex: 1, margin: 0 }}>{capture.title}</h2>
          <div className="detail-actions">
            <button
              className="btn-detail-delete"
              onClick={() => onDelete(capture.id)}
              title="Delete clip"
              aria-label="Delete clip"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-cat-inline">
          <span className="swatch-lg" style={{ background: `oklch(0.50 0.08 ${cat.hue})` }} />
          <span className="cat-name">{cat.label}</span>
        </div>
      </div>

      {showAssessment && (
        <div className="detail-section">
          <div className="detail-section-header">
            <div className="detail-section-label">Assessment</div>
          </div>
          <div className="axis-display">
            {!iNeutral && (
              <div className="axis-large">
                <div className="axis-name">Interest</div>
                <Wedge kind="interest" label={evaluation.interest} />
                <div className="axis-num" style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {evaluation.interest}
                </div>
              </div>
            )}
            {!eNeutral && (
              <div className="axis-large">
                <div className="axis-name">Ethics</div>
                <Wedge kind="ethics" label={evaluation.ethics} />
                <div className="axis-num" style={{ fontSize: 11, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {evaluation.ethics}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="detail-section detail-note-row">
        <div className="detail-section-label">Note</div>
        <NoteEditor note={capture.note} clipId={capture.id} onUpdateNote={onUpdateNote} />
      </div>

      {(capture.bodyHtml || capture.selectionText) ? (
        <div
          className="clip-body"
          dangerouslySetInnerHTML={{ __html: capture.bodyHtml ?? capture.selectionText ?? '' }}
        />
      ) : capture.bodyText ? (
        <div className="detail-section">
          {capture.thumbnail && (
            <img src={capture.thumbnail} alt="" className="detail-thumb" />
          )}
          <blockquote className="detail-excerpt">{capture.bodyText}</blockquote>
        </div>
      ) : null}
    </aside>
  );
}
