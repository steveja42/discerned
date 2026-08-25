// Controls whether the first-visit welcome popover is shown.
// State is derived from localStorage["discerned.seenHero"] — present means dismissed.
// Calling dismiss() hides the popover and writes the flag so it never shows again.

'use client';

import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'discerned.seenHero';

// Bumped on dismiss() so useSyncExternalStore re-reads. localStorage fires no
// event in the tab that wrote it, so the store is driven manually.
const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit() {
  for (const fn of listeners) fn();
}

function getSnapshot(): boolean {
  try { return !localStorage.getItem(KEY); } catch { return false; }
}

// The server has no localStorage, so it can never know this is a first visit.
// Returning false keeps SSR and the hydrating render identical; the real value
// is picked up on the first post-hydration read, with no extra render pass.
const getServerSnapshot = () => false;

export function useFirstVisit() {
  const notDismissed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Dev convenience: ?popover=1 forces the popover open without touching the
  // localStorage flag, so it doesn't clobber real dismissed state.
  const forced = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('popover') === '1';

  const dismiss = useCallback(() => {
    try { localStorage.setItem(KEY, '1'); } catch {}
    emit();
  }, []);

  return { showPopover: forced || notDismissed, dismiss };
}
