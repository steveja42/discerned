// Right-rail detail panel — renders the selected clip's full excerpt, signal stars,
// qualifiers, category swatch, and action buttons. Shows a placeholder when no clip is selected.

'use client';

import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ClipData } from '@/lib/types';
import type { ClipBody } from '@/lib/bridge/ClipStoreContext';
import { authorLabel, type AuthorProfile } from '@/lib/nostr/profiles';
import { CATEGORIES, signalRank } from '@/lib/constants';
import { requestClipBody } from '@/lib/bridge/extension-bridge';

interface DetailPanelProps {
  clip: ClipData | null;
  author?: AuthorProfile;
  onDelete: (id: string) => void;
  onUpdateNote: (id: string, note: string) => void;
  bodies: Map<string, ClipBody>;
  onBodyFetched: (id: string, body: ClipBody) => void;
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

function renderTextWithBreaks(text: string, imageUrls?: Set<string>): React.ReactNode {
  return text.split(/\n{2,}/).map((para, i) => {
    // Cast bodies interleave image URLs as their own paragraphs at the image's
    // original in-article position — render those as the image itself. Only
    // URLs declared by the event's imeta tags are rendered, never arbitrary
    // URLs that happen to appear in the text.
    const trimmed = para.trim();
    if (imageUrls?.has(trimmed)) {
      return <img key={i} className="cast-inline-img" src={trimmed} alt="" />;
    }
    return (
      <p key={i}>
        {para.split('\n').map((line, j, arr) => (
          <React.Fragment key={j}>
            {line}
            {j < arr.length - 1 && <br />}
          </React.Fragment>
        ))}
      </p>
    );
  });
}

export default function DetailPanel({ clip, author, onDelete, onUpdateNote, bodies, onBodyFetched }: DetailPanelProps) {
  // Request body from extension when clip changes and it's not cached yet.
  useEffect(() => {
    if (!clip) return;
    const { id, format, bodyHtml } = clip.capture;
    if (format === 'selection' || format === 'bookmark') return;
    if (bodyHtml) {
      // Clip arrived with body inline (e.g. imported JSON) — cache it now.
      if (!bodies.has(id)) onBodyFetched(id, { bodyHtml, thumbnail: clip.capture.thumbnail });
      return;
    }
    if (bodies.has(id)) return;
    requestClipBody(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.capture.id]);

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
  const caster = capture.authorPubkey ? authorLabel(capture.authorPubkey, author) : null;
  const cat = CATEGORIES[evaluation.category] ?? { label: evaluation.category, hue: 60 };
  const sRank = signalRank(evaluation.signal);
  const quals = evaluation.qualifiers ?? [];

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
          {caster && <span className="cat-author" title={caster}>{caster}</span>}
        </div>
      </div>

      {sRank > 0 && (
        <div className="detail-section">
          <div className="detail-section-header">
            <div className="detail-section-label">Signal</div>
          </div>
          <div className="signal-display">
            <span className="signal-stars-lg" aria-hidden>
              {'★'.repeat(sRank)}
              <span className="signal-stars-off">{'★'.repeat(5 - sRank)}</span>
            </span>
            <span className="signal-name-lg">{sRank} ★ {evaluation.signal}</span>
          </div>
        </div>
      )}

      {quals.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-header">
            <div className="detail-section-label">Qualifiers</div>
          </div>
          <div className="qual-tags">
            {quals.map((q) => (
              <span key={q} className="qual-chip">{q}</span>
            ))}
          </div>
        </div>
      )}

      <div className="detail-section detail-note-row">
        <div className="detail-section-label">Note</div>
        <NoteEditor note={capture.note} clipId={capture.id} onUpdateNote={onUpdateNote} />
      </div>

      {(() => {
        const cached = bodies.get(capture.id);
        const bodyHtml = cached?.bodyHtml ?? capture.bodyHtml;
        const thumbnail = cached?.thumbnail ?? capture.thumbnail;
        // The author's own bridged clips carry rich dx-* bodyHtml — render it as
        // before (full fidelity). It wins over the public markdown.
        if (bodyHtml) {
          return (
            <div
              className="clip-body"
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          );
        }
        // Public NIP-23 long-form (kind 30023): content is markdown. Render it
        // through the same .clip-body prose styles. Images resolve from the
        // markdown's http(s) URLs; react-markdown never emits raw HTML by
        // default, so this is safe without an extra sanitiser pass.
        //
        // The extension strips the leading title heading + hero image from the
        // markdown (NIP-23 clients render those from the title/image tags to
        // avoid duplication). The panel head already shows the title, so we only
        // need to render the hero image (from the `image` tag → thumbnail) here,
        // above the body.
        if (capture.markdown) {
          return (
            <div className="clip-body">
              {thumbnail && <img className="longform-hero" src={thumbnail} alt="" />}
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{capture.markdown}</ReactMarkdown>
            </div>
          );
        }
        // Casts carry every content image as an imeta URL. Article bodies
        // interleave those URLs at each image's original in-article position —
        // render those inline (renderTextWithBreaks swaps the URL paragraph
        // for the image). URLs NOT in the body (tweet casts, truncated bodies)
        // render as a top gallery. The single `image`-tag thumbnail is the
        // first imeta URL, so it only shows when there are no imeta images.
        const photoUrls = capture.imageUrls ?? [];
        const bodyText = capture.bodyText ?? '';
        const inlineUrls = new Set(photoUrls.filter((u) => bodyText.includes(u)));
        const galleryUrls = photoUrls.filter((u) => !inlineUrls.has(u));
        if (capture.selectionText || capture.bodyText || thumbnail || photoUrls.length > 0) {
          return (
            <div className="clip-body">
              {galleryUrls.length > 0
                ? (
                  <div className="cast-photos">
                    {galleryUrls.map((src, i) => <img key={i} src={src} alt="" />)}
                  </div>
                )
                : photoUrls.length === 0 && thumbnail && <img src={thumbnail} alt="" />}
              {capture.selectionText && (
                <blockquote
                  className="detail-excerpt"
                  dangerouslySetInnerHTML={{ __html: capture.selectionText }}
                />
              )}
              {capture.bodyText && renderTextWithBreaks(capture.bodyText, inlineUrls)}
            </div>
          );
        }
        return null;
      })()}
    </aside>
  );
}
