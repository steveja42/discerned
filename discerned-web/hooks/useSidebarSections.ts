// Tracks which Discerns-sidebar sections are expanded. Persisted to localStorage so
// the layout the user settled on survives reloads.
// Modelled on useReadCasts: a module-level snapshot + listeners driving
// useSyncExternalStore, with a server snapshot that matches the hydrating client render.

'use client';

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'discerned.sidebarSections';

export type SectionId = 'view' | 'following' | 'publishers' | 'signal' | 'qualifiers' | 'category';

// The long sections start closed so the short ones stay reachable without scrolling
// the 200px column.
const DEFAULTS: Record<SectionId, boolean> = {
  view: true,
  following: true,
  publishers: false,
  signal: true,
  qualifiers: false,
  category: false,
};

const SECTION_IDS = Object.keys(DEFAULTS) as SectionId[];

export type SectionState = Record<SectionId, boolean>;

function load(): SectionState {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return DEFAULTS;
    const stored = parsed as Record<string, unknown>;
    // Read only known ids, and fall back to the default for any that are missing —
    // a section added later must not read as "closed" from older stored state.
    const next = { ...DEFAULTS };
    for (const id of SECTION_IDS) {
      if (typeof stored[id] === 'boolean') next[id] = stored[id] as boolean;
    }
    return next;
  } catch {
    return DEFAULTS;
  }
}

function save(state: SectionState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private mode, quota); state still works in-memory.
  }
}

// The section map is the store. getSnapshot MUST return a stable reference or
// useSyncExternalStore re-renders forever, so the current object is cached here and
// only replaced when toggle actually changes something.
let snapshot: SectionState | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getSnapshot(): SectionState {
  snapshot ??= load();
  return snapshot;
}

// No localStorage on the server: everything renders at its default, which matches
// the hydrating client render.
const getServerSnapshot = () => DEFAULTS;

export function useSidebarSections() {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback((id: SectionId) => {
    const prev = getSnapshot();
    const next = { ...prev, [id]: !prev[id] };
    snapshot = next;
    save(next);
    for (const fn of listeners) fn();
  }, []);

  return { open, toggle };
}
