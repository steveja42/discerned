// Tracks which cast ids the user has read. Persisted to localStorage so the
// state survives reloads. Caps the stored set so it can't grow unboundedly.

'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'discerned.readCasts';
const MAX_TRACKED = 2000;

function load(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function save(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    // Keep the most-recently-added by trimming from the front when over cap.
    const arr = Array.from(ids);
    const trimmed = arr.length > MAX_TRACKED ? arr.slice(arr.length - MAX_TRACKED) : arr;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage may be unavailable (private mode, quota); reads still work in-memory.
  }
}

export function useReadCasts() {
  const [read, setRead] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setRead(load());
  }, []);

  const markRead = useCallback((id: string) => {
    setRead((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      save(next);
      return next;
    });
  }, []);

  return { read, markRead };
}
