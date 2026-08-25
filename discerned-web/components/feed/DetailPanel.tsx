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
  // Right-click on the caster label. Absent on call sites with no follow
  // concept (e.g. the private Library, which has no public authorPubkey).
  onAuthorContextMenu?: (pubkey: string, x: number, y: number) => void;
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

// The path portion of a URL (before '?'), lowercased — mirrors events.ts
// urlBase. Used to compare two URLs that point at the SAME image but differ in
// query params (CDN resize/cache tokens).
function urlBase(u: string): string {
  return u.split('?')[0].toLowerCase();
}

// Does the cast markdown already embed this image (as ![](url))? A plain
// substring check on the full thumbnail URL misses when the inline URL differs
// only by CDN query params, so we compare every markdown image URL by url-base
// (query strings stripped on both sides). When true, DetailPanel must NOT also
// render the thumbnail as a top hero — that showed the same image twice, with
// the duplicate on top and in the wrong position.
function markdownHasImage(markdown: string, imageUrl: string): boolean {
  if (markdown.includes(imageUrl)) return true;
  const target = urlBase(imageUrl);
  const re = /!\[[^\]]*\]\(([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    if (urlBase(m[1]) === target) return true;
  }
  return false;
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
  // Editor state is tagged with the clip it belongs to, so selecting a different
  // clip resets it during render instead of via a setState in an effect. Keying
  // on clipId alone is deliberate: the old effect also depended on `note`, so a
  // bridge update to the saved note would discard whatever the user was typing.
  const [entry, setEntry] = useState<{ clipId: string; editing: boolean; draft: string } | null>(null);
  const current = entry?.clipId === clipId ? entry : null;
  const editing = current?.editing ?? false;
  const draft = current?.draft ?? note ?? '';

  const setDraft = (next: string) => setEntry({ clipId, editing, draft: next });
  const beginEdit = (initial: string) => setEntry({ clipId, editing: true, draft: initial });

  const save = () => {
    onUpdateNote(clipId, draft);
    setEntry({ clipId, editing: false, draft });
  };

  // Set both fields at once — the setters above each rebuild the whole entry,
  // so calling them in sequence would discard the first one's change.
  const cancel = () => setEntry({ clipId, editing: false, draft: note ?? '' });

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
      <div className="note-display" onClick={() => beginEdit(note)}>
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
      onClick={() => beginEdit('')}
    >
      Add a note…
    </span>
  );
}

// Cast images are HOTLINKED from the source site — the cast publishes a real
// http(s) URL because data: URIs are far too large for relays (the private clip
// keeps the inlined base64 instead). Many sites, WordPress news sites in
// particular, serve a 403 when the Referer is a foreign origin: off-guardian.org
// returns 200 with no referer and 403 for `https://discerned.online/`, so the
// article's banner silently failed to load and the cast rendered image-less
// while the clip looked fine. `no-referrer` sends none at all, which those
// hotlink rules allow. Applied to EVERY cast-image path (markdown, hero,
// gallery, inline) so the behaviour doesn't depend on which one renders.
const MD_COMPONENTS = {
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) =>
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img {...props} referrerPolicy="no-referrer" />,
};

function renderTextWithBreaks(text: string, imageUrls?: Set<string>): React.ReactNode {
  return text.split(/\n{2,}/).map((para, i) => {
    // Cast bodies interleave image URLs as their own paragraphs at the image's
    // original in-article position — render those as the image itself. Only
    // URLs declared by the event's imeta tags are rendered, never arbitrary
    // URLs that happen to appear in the text.
    const trimmed = para.trim();
    if (imageUrls?.has(trimmed)) {
      return <img key={i} className="cast-inline-img" src={trimmed} alt="" referrerPolicy="no-referrer" />;
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

export default function DetailPanel({ clip, author, onDelete, onUpdateNote, bodies, onBodyFetched, onAuthorContextMenu }: DetailPanelProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Leaving fullscreen when the selected clip changes underneath it (e.g. List
  // view's single detail pane swaps clips while a card is expanded) avoids a
  // stale fullscreen staying pinned to a clip that's no longer selected. Reset
  // during render (React's documented pattern for state keyed to a prop)
  // rather than in an effect, which would cause an extra commit.
  const [renderedId, setRenderedId] = useState(clip?.capture.id ?? null);
  if (renderedId !== (clip?.capture.id ?? null)) {
    setRenderedId(clip?.capture.id ?? null);
    if (isFullscreen) setIsFullscreen(false);
  }

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
    <aside className={`detail${isFullscreen ? ' detail--fullscreen' : ''}`}>
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
          <button
            className="detail-close"
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Exit fullscreen' : 'Expand to fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Expand to fullscreen'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              {isFullscreen
                ? <><line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" /></>
                : <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>}
            </svg>
          </button>
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
          {caster && (
            <span
              className="cat-author"
              title={caster}
              onContextMenu={(e) => {
                if (!onAuthorContextMenu || !capture.authorPubkey) return;
                e.preventDefault();
                onAuthorContextMenu(capture.authorPubkey, e.clientX, e.clientY);
              }}
            >
              {caster}
            </span>
          )}
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
          // Tweet casts (and any article whose media sits mid-body) carry the
          // thumbnail INSIDE the markdown as ![](url) at its original position
          // — rendering the hero on top of that would show the same image
          // twice, in the wrong place first. Only render the hero when the
          // markdown does not already contain it.
          const heroInBody =
            !!thumbnail && markdownHasImage(capture.markdown, thumbnail);
          return (
            <div className="clip-body">
              {thumbnail && !heroInBody && <img className="longform-hero" src={thumbnail} alt="" referrerPolicy="no-referrer" />}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{capture.markdown}</ReactMarkdown>
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
                    {galleryUrls.map((src, i) => <img key={i} src={src} alt="" referrerPolicy="no-referrer" />)}
                  </div>
                )
                : photoUrls.length === 0 && thumbnail && <img src={thumbnail} alt="" referrerPolicy="no-referrer" />}
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
