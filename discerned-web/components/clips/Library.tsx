// Private Library — shows clips delivered from the Discerned extension via postMessage.
// Renders a folder sidebar, clip list, and detail panel. If the bridge times out (2s)
// with no extension present, shows LibraryEmpty with the install prompt instead.

'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import type React from 'react';
import { useLibraryBridge } from '@/hooks/useLibraryBridge';
import { CATEGORIES, SIGNAL_LEVELS, deriveQualifierOptions, matchesQualifiers, matchesSignal } from '@/lib/constants';

function categoryHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}
import ClipRow from '@/components/feed/ClipRow';
import DetailPanel from '@/components/feed/DetailPanel';
import LibraryEmpty from './LibraryEmpty';
import BulkActionBar from './BulkActionBar';
import ResizableLayout from '@/components/layout/ResizableLayout';
import { exportClipsJson } from '@/lib/export-utils';

interface SidebarLocalProps {
  activeCat: string | null;
  setActiveCat: (c: string | null) => void;
  catCounts: Record<string, number>;
  totalCount: number;
  activeSignals: string[];
  toggleSignal: (s: string) => void;
  activeQuals: string[];
  toggleQual: (q: string) => void;
  qualOptions: string[];
  allCategories: Record<string, { label: string; hue: number }>;
  onDeleteCategory: (key: string) => void;
  onSelectAllInCategory: (key: string) => void;
}

function SidebarLocal({ activeCat, setActiveCat, catCounts, totalCount, activeSignals, toggleSignal, activeQuals, toggleQual, qualOptions, allCategories, onDeleteCategory, onSelectAllInCategory }: SidebarLocalProps) {
  return (
    <aside className="sidebar">
      <div className="side-section-label" style={{ fontSize: '1.25rem', fontFamily: 'var(--serif)', fontStyle: 'italic', fontWeight: 700, letterSpacing: 0, textTransform: 'none', color: 'var(--ink)', marginBottom: '0.3rem' }}>Clips</div>
      <div>
        <ul className="nav-list">
          <li
            className={`nav-item ${activeCat === null ? 'active' : ''}`}
            onClick={() => setActiveCat(null)}
          >
            All clips <span className="nav-count">{totalCount}</span>
          </li>
        </ul>
      </div>

      <div>
        <div className="side-section-label">
          Folders <span className="count">{Object.keys(allCategories).length}</span>
        </div>
        <ul className="nav-list folder-list">
          {Object.entries(allCategories).map(([key, cat]) => {
            const c = catCounts[key] ?? 0;
            const active = activeCat === key;
            return (
              <li
                key={key}
                className={`nav-item folder ${active ? 'active' : ''}`}
                onClick={() => setActiveCat(active ? null : key)}
              >
                <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke={`oklch(0.50 0.08 ${cat.hue})`} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
                  {active
                    ? <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2" /><path d="m3 9 2 9a2 2 0 0 0 2 1.5h12a2 2 0 0 0 2-1.5l1.5-7a1 1 0 0 0-1-1.2H5" /></>
                    : <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
                </svg>
                <span style={{ flex: 1 }}>{cat.label}</span>
                <span className="nav-count">{c}</span>
                <button
                  className="folder-select-all"
                  onClick={(e) => { e.stopPropagation(); onSelectAllInCategory(key); }}
                  title={`Select all in ${cat.label}`}
                  aria-label={`Select all in ${cat.label}`}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                    <rect x="2" y="2" width="5" height="5" rx="1" />
                    <rect x="9" y="2" width="5" height="5" rx="1" />
                    <rect x="2" y="9" width="5" height="5" rx="1" />
                    <path d="M9.5 11.5h5M12 9v5" />
                  </svg>
                </button>
                <button
                  className="folder-delete"
                  onClick={(e) => { e.stopPropagation(); onDeleteCategory(key); }}
                  title={`Delete ${cat.label} and its clips`}
                  aria-label={`Delete ${cat.label}`}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                    <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5l.5-9" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="filters">
        <div className="side-section-label">Filter</div>
        <div className="axis-filter">
          <div className="axis-filter-head">
            <span>Signal</span>
            <span className="axis-letter">S</span>
          </div>
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
        </div>
        {qualOptions.length > 0 && (
          <div className="axis-filter">
            <div className="axis-filter-head">
              <span>Qualifiers</span>
              <span className="axis-letter">Q</span>
            </div>
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
          </div>
        )}
      </div>
    </aside>
  );
}

interface LibraryProps {
  initialClipId?: string;
  searchQuery?: string;
}

export default function Library({ initialClipId, searchQuery }: LibraryProps) {
  const { bridgePresent, clips, timedOut, categories, bodies, removeClips, updateClipNote, removeCategory, setClipBody, focusClipId, clearFocusClipId } = useLibraryBridge();

  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [activeSignals, setActiveSignals] = useState<string[]>([]);
  const [activeQuals, setActiveQuals] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialClipId ?? null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Reacts to the extension deep-linking at a specific clip (NAVIGATE_TO_CLIP over
  // the bridge). This is a genuine external-event handler: it must both move the
  // selection AND acknowledge the request via clearFocusClipId(), so it can't be
  // derived during render the way the other reset-on-key state in this app is —
  // hence the set-state-in-effect exemption rather than a rewrite.
  //
  // Declared after the state above: it reads activeCat and calls both setters, so
  // hoisting it would put them in the temporal dead zone.
  useEffect(() => {
    if (!focusClipId) return;
    const clip = clips.find((c) => c.capture.id === focusClipId);
    /* eslint-disable react-hooks/set-state-in-effect -- see note above */
    if (clip && activeCat !== null) setActiveCat(clip.evaluation.category);
    setSelectedId(focusClipId);
    /* eslint-enable react-hooks/set-state-in-effect */
    clearFocusClipId();
  // clips + activeCat intentionally omitted — we only want this to fire when focusClipId changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusClipId, clearFocusClipId]);

  const q = searchQuery?.trim().toLowerCase() ?? '';

  const qualOptions = useMemo(() => deriveQualifierOptions(clips), [clips]);
  const toggleSignal = (sig: string) =>
    setActiveSignals((prev) => (prev.includes(sig) ? prev.filter((x) => x !== sig) : [...prev, sig]));
  const toggleQual = (qual: string) =>
    setActiveQuals((prev) => (prev.includes(qual) ? prev.filter((x) => x !== qual) : [...prev, qual]));

  const filtered = useMemo(() =>
    clips.filter((c) => {
      if (activeCat && c.evaluation.category !== activeCat) return false;
      if (!matchesSignal(c.evaluation.signal, activeSignals)) return false;
      if (!matchesQualifiers(c.evaluation.qualifiers, activeQuals)) return false;
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
    }),
    [clips, activeCat, activeSignals, activeQuals, q],
  );

  const selected = filtered.find((c) => c.capture.id === selectedId) ?? filtered[0] ?? null;

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    clips.forEach((c) => { m[c.evaluation.category] = (m[c.evaluation.category] ?? 0) + 1; });
    return m;
  }, [clips]);

  // Build display map from the unified categories list sent by the bridge.
  // Fall back to the CATEGORIES constant for hue/label if available; otherwise hash the name.
  const allCategories = useMemo(() => {
    const map: Record<string, { label: string; hue: number }> = {};
    categories.forEach((name) => {
      const builtin = CATEGORIES[name as keyof typeof CATEGORIES];
      map[name] = builtin ?? { label: name, hue: categoryHue(name) };
    });
    return map;
  }, [categories]);

  const showEmpty = timedOut && !bridgePresent;

  // Tracks the last clip clicked without shift, for shift-range selection.
  const lastClickedId = useRef<string | null>(null);

  const handleSelectToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    lastClickedId.current = id;
  };

  const handleRowClick = (id: string, e: React.MouseEvent) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isShift && lastClickedId.current) {
      // Range select: select all clips between lastClickedId and id.
      const ids = filtered.map((c) => c.capture.id);
      const a = ids.indexOf(lastClickedId.current);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const rangeIds = ids.slice(lo, hi + 1);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          rangeIds.forEach((rid) => next.add(rid));
          return next;
        });
      }
      return;
    }

    if (isCtrl) {
      // Toggle this clip into/out of selection.
      handleSelectToggle(id);
      return;
    }

    if (selectedIds.size > 0) {
      // In select mode: plain click toggles.
      handleSelectToggle(id);
      return;
    }

    // Normal click: open detail.
    lastClickedId.current = id;
    setSelectedId(id);
  };

  const handleBulkDelete = () => {
    const ids = [...selectedIds];
    removeClips(ids);
    setSelectedIds(new Set());
    if (selectedId && selectedIds.has(selectedId)) setSelectedId(null);
  };

  const handleBulkExport = () => {
    const toExport = filtered.filter((c) => selectedIds.has(c.capture.id));
    exportClipsJson(toExport);
  };

  const handleSingleDelete = (id: string) => {
    removeClips([id]);
    if (selectedId === id) setSelectedId(null);
  };

  const handleDeleteCategory = (key: string) => {
    const clipIds = clips.filter((c) => c.evaluation.category === key).map((c) => c.capture.id);
    const catLabel = allCategories[key]?.label ?? key;
    const clipWord = clipIds.length === 1 ? 'clip' : 'clips';
    const msg = `Delete "${catLabel}" and its ${clipIds.length} ${clipWord}?\n\nThis cannot be undone.`;
    if (!window.confirm(msg)) return;
    removeCategory(key);
    if (clipIds.length > 0) removeClips(clipIds);
    if (activeCat === key) setActiveCat(null);
    if (selectedId && clipIds.includes(selectedId)) setSelectedId(null);
    setSelectedIds((prev) => {
      if (clipIds.some((id) => prev.has(id))) {
        const next = new Set(prev);
        clipIds.forEach((id) => next.delete(id));
        return next;
      }
      return prev;
    });
  };

  const handleSelectAllInCategory = (key: string) => {
    const ids = clips.filter((c) => c.evaluation.category === key).map((c) => c.capture.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    setActiveCat(key);
  };

  const feedContent = (
    <main className="feed-col">
      <div className="feed-scroll">
        {showEmpty ? (
          <LibraryEmpty />
        ) : !bridgePresent ? (
          <div className="feed-empty">Waiting for extension…</div>
        ) : filtered.length === 0 ? (
          <div className="feed-empty">{q ? `No clips match "${searchQuery}".` : 'No clips match these filters.'}</div>
        ) : (
          <div className="feed-list">
            {filtered.map((clip, i) => (
              <ClipRow
                key={clip.capture.id ?? i}
                clip={clip}
                selected={selected?.capture.id === clip.capture.id}
                onClick={(e) => handleRowClick(clip.capture.id, e)}
                isSelectMode={selectedIds.size > 0}
                isSelected={selectedIds.has(clip.capture.id)}
                onSelect={handleSelectToggle}
              />
            ))}
          </div>
        )}
      </div>

      <BulkActionBar
        count={selectedIds.size}
        onDelete={handleBulkDelete}
        onExport={handleBulkExport}
        onClear={() => setSelectedIds(new Set())}
      />
    </main>
  );

  return (
    <div className="app">
      <ResizableLayout
        sidebar={
          <SidebarLocal
            activeCat={activeCat}
            setActiveCat={setActiveCat}
            catCounts={catCounts}
            totalCount={clips.length}
            activeSignals={activeSignals}
            toggleSignal={toggleSignal}
            activeQuals={activeQuals}
            toggleQual={toggleQual}
            qualOptions={qualOptions}
            allCategories={allCategories}
            onDeleteCategory={handleDeleteCategory}
            onSelectAllInCategory={handleSelectAllInCategory}
          />
        }
        feed={feedContent}
        detail={
          <DetailPanel
            clip={selected}
            onDelete={handleSingleDelete}
            onUpdateNote={updateClipNote}
            bodies={bodies}
            onBodyFetched={setClipBody}
          />
        }
        initialSidebarWidth={200}
      />
    </div>
  );
}
