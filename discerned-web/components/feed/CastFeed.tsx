// Main public Cast feed shell — the home page's primary content area.
// Owns all filter state (category, interest/ethics minimums, active follow) and
// derives the filtered clip list. Renders the three-column layout: Sidebar / feed list / DetailPanel.

'use client';

import { useState, useMemo } from 'react';
import { npubEncode } from 'nostr-tools/nip19';
import { CATEGORIES, INTEREST_LEVELS, ETHICS_LEVELS, interestRank, ethicsRank } from '@/lib/constants';
import type { ClipData } from '@/lib/types';
import type { FollowProfile } from '@/lib/nostr/follows';
import type { GlyphVariant } from '@/components/glyph/Glyph';
import ClipRow from './ClipRow';
import DetailPanel from './DetailPanel';
import FilterStrip from './FilterStrip';
import ResizableLayout from '@/components/layout/ResizableLayout';

// Left sidebar: View shortcuts, follows list, and axis/category filter controls.
interface SidebarProps {
  activeCat: string | null;
  setActiveCat: (c: string | null) => void;
  interestMin: number;
  setInterestMin: (n: number) => void;
  ethicsMin: number;
  setEthicsMin: (n: number) => void;
  activeFollow: string;
  setActiveFollow: (f: string) => void;
  count: number;
  unreadCount: number;
  follows: FollowProfile[];
  isSignedIn: boolean;
}

// npub for a follow, used wherever the key is shown to the user (never hex).
function followNpub(f: FollowProfile): string {
  try { return npubEncode(f.pubkey); } catch { return f.pubkey; }
}

function followInitial(f: FollowProfile): string {
  // Fall back to the first char past the shared "npub1" prefix, not raw hex.
  return (f.name?.trim()?.[0] ?? followNpub(f)[5] ?? '·').toUpperCase();
}

function Sidebar({
  activeCat, setActiveCat,
  interestMin, setInterestMin,
  ethicsMin, setEthicsMin,
  activeFollow, setActiveFollow,
  count,
  unreadCount,
  follows,
  isSignedIn,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div>
        <div className="side-section-label">View</div>
        <ul className="nav-list">
          <li
            className={`nav-item ${activeCat === null && activeFollow === 'all' ? 'active' : ''}`}
            onClick={() => { setActiveCat(null); setActiveFollow('all'); }}
          >
            All discerned <span className="nav-count">{count}</span>
          </li>
          <li
            className={`nav-item ${activeFollow === 'unread' ? 'active' : ''}`}
            onClick={() => setActiveFollow(activeFollow === 'unread' ? 'all' : 'unread')}
          >
            Unread <span className="nav-count">{unreadCount}</span>
          </li>
        </ul>
      </div>

      <div>
        <div className="side-section-label">
          Following <span className="count">{follows.length}</span>
        </div>
        {!isSignedIn ? (
          <div className="follows-empty">Sign in to see who you follow.</div>
        ) : follows.length === 0 ? (
          <div className="follows-empty">No follows yet.</div>
        ) : (
          <div className="follows">
            {follows.map((f) => (
              <div
                key={f.pubkey}
                className={`follow ${activeFollow === f.pubkey ? 'active' : ''}`}
                onClick={() => setActiveFollow(activeFollow === f.pubkey ? 'all' : f.pubkey)}
              >
                {f.picture
                  ? <img className="av av-img" src={f.picture} alt="" />
                  : <span className="av">{followInitial(f)}</span>}
                <span className="name">{f.name || `${followNpub(f).slice(0, 12)}…`}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="filters">
        <div className="side-section-label">Filter by dimension</div>

        <div className="axis-filter">
          <div className="axis-filter-head">
            <span>
              Interest{' '}
              <span style={{ color: 'var(--ink-4)', fontWeight: 400, fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                ≥ {interestMin === 0 ? '—' : INTEREST_LEVELS[interestMin - 1]}
              </span>
            </span>
            <span className="axis-letter">I</span>
          </div>
          <div className="axis-range">
            {INTEREST_LEVELS.map((lvl, i) => (
              <div
                key={lvl}
                className={`pip ${i + 1 <= interestMin ? 'active interest' : ''}`}
                onClick={() => setInterestMin(i + 1 === interestMin ? 0 : i + 1)}
                title={lvl}
              >
                {lvl[0]}
              </div>
            ))}
          </div>
        </div>

        <div className="axis-filter">
          <div className="axis-filter-head">
            <span>
              Ethics{' '}
              <span style={{ color: 'var(--ink-4)', fontWeight: 400, fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                ≥ {ethicsMin === 0 ? '—' : ETHICS_LEVELS[ethicsMin - 1]}
              </span>
            </span>
            <span className="axis-letter">E</span>
          </div>
          <div className="axis-range">
            {ETHICS_LEVELS.map((lvl, i) => (
              <div
                key={lvl}
                className={`pip ${i + 1 <= ethicsMin ? 'active ethics' : ''}`}
                onClick={() => setEthicsMin(i + 1 === ethicsMin ? 0 : i + 1)}
                title={lvl}
              >
                {lvl[0]}
              </div>
            ))}
          </div>
        </div>

        <div className="axis-filter">
          <div className="axis-filter-head">
            <span>Category</span>
            <span className="axis-letter">C</span>
          </div>
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
        </div>
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
  glyphVariant?: GlyphVariant;
  status: 'connecting' | 'live' | 'error';
  clips: ClipData[];
  searchQuery?: string;
  follows?: FollowProfile[];
  isSignedIn?: boolean;
  read?: Set<string>;
  markRead?: (id: string) => void;
}

// A 64-char hex pubkey marks an author filter; the other activeFollow values
// ('all' / 'unread') are view sentinels.
const isPubkey = (v: string) => /^[0-9a-f]{64}$/.test(v);
const EMPTY_READ: Set<string> = new Set();

export default function CastFeed({ glyphVariant = 'bars', status, clips, searchQuery, follows = [], isSignedIn = false, read, markRead }: CastFeedProps) {
  const readSet = read ?? EMPTY_READ;
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [interestMin, setInterestMin] = useState(0);
  const [ethicsMin, setEthicsMin] = useState(0);
  const [activeFollow, setActiveFollow] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const q = searchQuery?.trim().toLowerCase() ?? '';

  const unreadCount = useMemo(
    () => clips.reduce((n, c) => (readSet.has(c.capture.id) ? n : n + 1), 0),
    [clips, readSet],
  );

  const filtered = useMemo(() => clips.filter((c) => {
    if (activeCat && c.evaluation.category !== activeCat) return false;
    if (interestRank(c.evaluation.interest) + 1 < interestMin) return false;
    if (ethicsRank(c.evaluation.ethics) + 1 < ethicsMin) return false;
    if (activeFollow === 'unread' && readSet.has(c.capture.id)) return false;
    if (isPubkey(activeFollow) && c.capture.authorPubkey !== activeFollow) return false;
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
  }), [clips, activeCat, interestMin, ethicsMin, activeFollow, q, readSet]);

  const selected = filtered.find((c) => c.capture.id === selectedId) ?? filtered[0] ?? null;

  const handleSelectClip = (id: string) => {
    setSelectedId(id);
    markRead?.(id);
  };

  const feedContent = (
    <main className="feed-col">
      <div className="feed-head">
        <div>
          <h1 className="feed-title"><em>Discernments</em></h1>
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
        interestMin={interestMin}
        ethicsMin={ethicsMin}
        activeCat={activeCat}
        onClearInterest={() => setInterestMin(0)}
        onClearEthics={() => setEthicsMin(0)}
        onClearCat={() => setActiveCat(null)}
        onClearAll={() => { setInterestMin(0); setEthicsMin(0); setActiveCat(null); setActiveFollow('all'); }}
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
                glyphVariant={glyphVariant}
              />
            ))
          )}
        </div>
      </div>

      <div className="sov-strip">
        <span className="item"><span className="ok-dot" />Local-first · IndexedDB</span>
        <span className="item"><span className="pulse-dot" />Connected to <span className="relay-count">3 relays</span></span>
        <span className="item">
          <Icon name="github" /> Extension on GitHub
        </span>
        <span className="spacer" />
        <span className="item"><a>Export NIP-23</a></span>
        <span className="item"><a>Public key visible</a></span>
      </div>
    </main>
  );

  return (
    <div className="app">
      <ResizableLayout
        sidebar={
          <Sidebar
            activeCat={activeCat} setActiveCat={setActiveCat}
            interestMin={interestMin} setInterestMin={setInterestMin}
            ethicsMin={ethicsMin} setEthicsMin={setEthicsMin}
            activeFollow={activeFollow} setActiveFollow={setActiveFollow}
            count={clips.length}
            unreadCount={unreadCount}
            follows={follows}
            isSignedIn={isSignedIn}
          />
        }
        feed={feedContent}
        detail={<DetailPanel clip={selected} onDelete={() => {}} onUpdateNote={() => {}} bodies={new Map()} onBodyFetched={() => {}} />}
        initialSidebarWidth={200}
      />
    </div>
  );
}
