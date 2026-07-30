// Main public Cast feed shell — the home page's primary content area.
// Owns all filter state (category, signal minimum, qualifiers, active follow) and
// derives the filtered clip list. Renders the three-column layout: Sidebar / feed list / DetailPanel.

'use client';

import { useState, useMemo } from 'react';
import { npubEncode } from 'nostr-tools/nip19';
import { CATEGORIES, SIGNAL_LEVELS, deriveQualifierOptions, matchesAuthors, matchesQualifiers, matchesSignal } from '@/lib/constants';
import type { ClipData } from '@/lib/types';
import type { FollowProfile } from '@/lib/nostr/follows';
import { authorDisplayName, type AuthorProfile } from '@/lib/nostr/profiles';
import ClipRow from './ClipRow';
import DetailPanel from './DetailPanel';
import FilterStrip from './FilterStrip';
import ResizableLayout from '@/components/layout/ResizableLayout';
import CollapsibleSection from '@/components/layout/CollapsibleSection';
import { useSidebarSections } from '@/hooks/useSidebarSections';

// One publisher in the sidebar list: an author present in the loaded feed, with how
// many of the loaded discerns they published.
interface Publisher {
  pubkey: string;
  count: number;
}

// Left sidebar: View shortcuts, follows list, publishers list, and
// signal/qualifier/category filter controls.
interface SidebarProps {
  activeCat: string | null;
  setActiveCat: (c: string | null) => void;
  activeSignals: string[];
  toggleSignal: (s: string) => void;
  activeQuals: string[];
  toggleQual: (q: string) => void;
  qualOptions: string[];
  // Following and Publishers write to one shared selection set: the same person can
  // appear in both lists, so selecting them in either must mean the same thing.
  activeAuthors: string[];
  toggleAuthor: (pubkey: string) => void;
  unreadOnly: boolean;
  setUnreadOnly: (v: boolean) => void;
  clearFilters: () => void;
  count: number;
  unreadCount: number;
  follows: FollowProfile[];
  publishers: Publisher[];
  authors: Map<string, AuthorProfile>;
  isSignedIn: boolean;
}

// npub for a pubkey, used wherever the key is shown to the user (never hex).
function toNpub(pubkey: string): string {
  try { return npubEncode(pubkey); } catch { return pubkey; }
}

// Avatar letter: the name's first char, else the first char past the shared
// "npub1" prefix — never raw hex.
function avatarInitial(pubkey: string, name?: string): string {
  return (name?.trim()?.[0] ?? toNpub(pubkey)[5] ?? '·').toUpperCase();
}

function Sidebar({
  activeCat, setActiveCat,
  activeSignals, toggleSignal,
  activeQuals, toggleQual, qualOptions,
  activeAuthors, toggleAuthor,
  unreadOnly, setUnreadOnly,
  clearFilters,
  count,
  unreadCount,
  follows,
  publishers,
  authors,
  isSignedIn,
}: SidebarProps) {
  const { open, toggle } = useSidebarSections();

  return (
    <aside className="sidebar">
      <CollapsibleSection title="View" open={open.view} onToggle={() => toggle('view')}>
        <ul className="nav-list">
          <li
            className={`nav-item ${activeCat === null && activeAuthors.length === 0 && !unreadOnly ? 'active' : ''}`}
            onClick={clearFilters}
          >
            All discerned <span className="nav-count">{count}</span>
          </li>
          <li
            className={`nav-item ${unreadOnly ? 'active' : ''}`}
            onClick={() => setUnreadOnly(!unreadOnly)}
          >
            Unread <span className="nav-count">{unreadCount}</span>
          </li>
        </ul>
      </CollapsibleSection>

      <CollapsibleSection
        title="Following"
        badge={<span className="count">{follows.length}</span>}
        open={open.following}
        onToggle={() => toggle('following')}
      >
        {!isSignedIn ? (
          <div className="follows-empty">Sign in to see who you follow.</div>
        ) : follows.length === 0 ? (
          <div className="follows-empty">No follows yet.</div>
        ) : (
          <div className="follows">
            {follows.map((f) => (
              <div
                key={f.pubkey}
                className={`follow ${activeAuthors.includes(f.pubkey) ? 'active' : ''}`}
                onClick={() => toggleAuthor(f.pubkey)}
                title={toNpub(f.pubkey)}
                role="checkbox"
                aria-checked={activeAuthors.includes(f.pubkey)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAuthor(f.pubkey); }
                }}
              >
                {f.picture
                  ? <img className="av av-img" src={f.picture} alt="" />
                  : <span className="av">{avatarInitial(f.pubkey, f.name)}</span>}
                <span className="name">{f.name || `${toNpub(f.pubkey).slice(0, 12)}…`}</span>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title="Publishers"
        badge={<span className="count">{publishers.length}</span>}
        open={open.publishers}
        onToggle={() => toggle('publishers')}
      >
        {publishers.length === 0 ? (
          <div className="follows-empty">No publishers yet.</div>
        ) : (
          <div className="follows">
            {publishers.map((p) => {
              const profile = authors.get(p.pubkey);
              const label = authorDisplayName(p.pubkey, profile);
              const selected = activeAuthors.includes(p.pubkey);
              return (
                <div
                  key={p.pubkey}
                  className={`follow ${selected ? 'active' : ''}`}
                  onClick={() => toggleAuthor(p.pubkey)}
                  title={toNpub(p.pubkey)}
                  role="checkbox"
                  aria-checked={selected}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAuthor(p.pubkey); }
                  }}
                >
                  <span className="av">{avatarInitial(p.pubkey, profile?.name)}</span>
                  <span className="name">{label}</span>
                  <span className="pub-count">{p.count}</span>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>

      <div className="filters">
        <div className="side-section-label">Filter</div>

        <CollapsibleSection
          title="Signal"
          badge={<span className="axis-letter">S</span>}
          open={open.signal}
          onToggle={() => toggle('signal')}
        >
          <div className="axis-range">
            {SIGNAL_LEVELS.map((lvl) => (
              <div
                key={lvl}
                className={`pip ${activeSignals.includes(lvl) ? 'active signal' : ''}`}
                onClick={() => toggleSignal(lvl)}
                title={lvl}
              >
                {lvl[0]}
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {qualOptions.length > 0 && (
          <CollapsibleSection
            title="Qualifiers"
            badge={<span className="axis-letter">Q</span>}
            open={open.qualifiers}
            onToggle={() => toggle('qualifiers')}
          >
            <div className="cat-filter">
              {qualOptions.map((qual) => (
                <button
                  key={qual}
                  className={`cat-chip ${activeQuals.includes(qual) ? 'active' : ''}`}
                  onClick={() => toggleQual(qual)}
                >
                  {qual}
                </button>
              ))}
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection
          title="Category"
          badge={<span className="axis-letter">C</span>}
          open={open.category}
          onToggle={() => toggle('category')}
        >
          <div className="cat-filter">
            {Object.entries(CATEGORIES).map(([key, cat]) => (
              <button
                key={key}
                className={`cat-chip ${activeCat === key ? 'active' : ''}`}
                onClick={() => setActiveCat(activeCat === key ? null : key)}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </CollapsibleSection>
      </div>
    </aside>
  );
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    chevdown: <polyline points="6 9 12 15 18 9" />,
    list: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></>,
    github: <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.1-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.93.36.3.68.92.68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />,
  };
  return (
    <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

interface CastFeedProps {
  status: 'connecting' | 'live' | 'error';
  clips: ClipData[];
  searchQuery?: string;
  follows?: FollowProfile[];
  authors?: Map<string, AuthorProfile>;
  isSignedIn?: boolean;
  read?: Set<string>;
  markRead?: (id: string) => void;
}

const EMPTY_READ: Set<string> = new Set();

const EMPTY_AUTHORS: Map<string, AuthorProfile> = new Map();

export default function CastFeed({ status, clips, searchQuery, follows = [], authors = EMPTY_AUTHORS, isSignedIn = false, read, markRead }: CastFeedProps) {
  const readSet = read ?? EMPTY_READ;
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [activeSignals, setActiveSignals] = useState<string[]>([]);
  const [activeQuals, setActiveQuals] = useState<string[]>([]);
  // Author pubkeys selected in EITHER the Following or Publishers list — one shared
  // set, since a person can be listed in both.
  const [activeAuthors, setActiveAuthors] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const q = searchQuery?.trim().toLowerCase() ?? '';

  const qualOptions = useMemo(() => deriveQualifierOptions(clips), [clips]);

  // Every author present in the loaded feed, most-published first. Derived from all
  // clips rather than the filtered list — deriving from `filtered` would shrink the
  // list to the selected publisher, leaving no way to switch to a different one.
  const publishers = useMemo<Publisher[]>(() => {
    const counts = new Map<string, number>();
    for (const c of clips) {
      const pk = c.capture.authorPubkey;
      if (pk) counts.set(pk, (counts.get(pk) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([pubkey, count]) => ({ pubkey, count }))
      .sort((a, b) => b.count - a.count);
  }, [clips]);

  const toggleSignal = (sig: string) =>
    setActiveSignals((prev) => (prev.includes(sig) ? prev.filter((x) => x !== sig) : [...prev, sig]));
  const toggleQual = (qual: string) =>
    setActiveQuals((prev) => (prev.includes(qual) ? prev.filter((x) => x !== qual) : [...prev, qual]));
  const toggleAuthor = (pubkey: string) =>
    setActiveAuthors((prev) => (prev.includes(pubkey) ? prev.filter((x) => x !== pubkey) : [...prev, pubkey]));

  const clearFilters = () => {
    setActiveSignals([]);
    setActiveQuals([]);
    setActiveCat(null);
    setActiveAuthors([]);
    setUnreadOnly(false);
  };

  // Pill labels for the selected authors. A follow carries its own kind-3 name, which
  // is the better label when the author has no kind-0 in the feed's profile map.
  const activeAuthorPills = useMemo(
    () => activeAuthors.map((pubkey) => {
      const followName = follows.find((f) => f.pubkey === pubkey)?.name?.trim();
      return {
        pubkey,
        label: followName || authorDisplayName(pubkey, authors.get(pubkey)),
      };
    }),
    [activeAuthors, authors, follows],
  );

  const unreadCount = useMemo(
    () => clips.reduce((n, c) => (readSet.has(c.capture.id) ? n : n + 1), 0),
    [clips, readSet],
  );

  const filtered = useMemo(() => clips.filter((c) => {
    if (activeCat && c.evaluation.category !== activeCat) return false;
    if (!matchesSignal(c.evaluation.signal, activeSignals)) return false;
    if (!matchesQualifiers(c.evaluation.qualifiers, activeQuals)) return false;
    if (unreadOnly && readSet.has(c.capture.id)) return false;
    if (!matchesAuthors(c.capture.authorPubkey, activeAuthors)) return false;
    if (q) {
      const hay = [
        c.capture.title,
        c.capture.selectionText,
        c.capture.selectionContext,
        c.capture.bodyText,
        c.capture.note,
        c.capture.url,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [clips, activeCat, activeSignals, activeQuals, activeAuthors, unreadOnly, q, readSet]);

  const selected = filtered.find((c) => c.capture.id === selectedId) ?? filtered[0] ?? null;

  const handleSelectClip = (id: string) => {
    setSelectedId(id);
    markRead?.(id);
  };

  const feedContent = (
    <main className="feed-col">
      <div className="feed-head">
        <div>
          <h1 className="feed-title"><em>Discerns</em></h1>
          <div className="feed-meta">
            {filtered.length} clips
            <span className="sep">·</span>
            live · Nostr
            <span className="sep">·</span>
            {status === 'connecting' ? 'connecting…' : status === 'live' ? 'live' : 'error'}
          </div>
        </div>
        <div className="feed-controls">
          <button className="sort">Sort: Recent <Icon name="chevdown" /></button>
          <div className="density">
            <button className="active"><Icon name="list" /></button>
            <button><Icon name="grid" /></button>
          </div>
        </div>
      </div>

      <FilterStrip
        activeSignals={activeSignals}
        activeQuals={activeQuals}
        activeCat={activeCat}
        activeAuthors={activeAuthorPills}
        onClearSignal={(sig) => setActiveSignals((prev) => prev.filter((x) => x !== sig))}
        onClearQual={(qual) => setActiveQuals((prev) => prev.filter((x) => x !== qual))}
        onClearCat={() => setActiveCat(null)}
        onClearAuthor={toggleAuthor}
        onClearAll={clearFilters}
      />

      <div className="feed-scroll">
        <div className="feed-list">
          {filtered.length === 0 ? (
            <div className="feed-empty">
              {q ? `No casts match "${searchQuery}".` : 'No clips match these filters.'}
            </div>
          ) : (
            filtered.map((clip) => (
              <ClipRow
                key={clip.capture.id}
                clip={clip}
                selected={selected?.capture.id === clip.capture.id}
                onClick={() => handleSelectClip(clip.capture.id)}
                author={clip.capture.authorPubkey ? authors.get(clip.capture.authorPubkey) : undefined}
              />
            ))
          )}
        </div>
      </div>
    </main>
  );

  return (
    <div className="app">
      <ResizableLayout
        sidebar={
          <Sidebar
            activeCat={activeCat} setActiveCat={setActiveCat}
            activeSignals={activeSignals} toggleSignal={toggleSignal}
            activeQuals={activeQuals} toggleQual={toggleQual} qualOptions={qualOptions}
            activeAuthors={activeAuthors} toggleAuthor={toggleAuthor}
            unreadOnly={unreadOnly} setUnreadOnly={setUnreadOnly}
            clearFilters={clearFilters}
            count={clips.length}
            unreadCount={unreadCount}
            follows={follows}
            publishers={publishers}
            authors={authors}
            isSignedIn={isSignedIn}
          />
        }
        feed={feedContent}
        detail={<DetailPanel clip={selected} author={selected?.capture.authorPubkey ? authors.get(selected.capture.authorPubkey) : undefined} onDelete={() => {}} onUpdateNote={() => {}} bodies={new Map()} onBodyFetched={() => {}} />}
        initialSidebarWidth={200}
      />
    </div>
  );
}
