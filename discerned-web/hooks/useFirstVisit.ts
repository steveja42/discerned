// Controls whether the first-visit welcome popover is shown.
// State is derived from localStorage["discerned.seenHero"] — present means dismissed.
// Calling dismiss() hides the popover and writes the flag so it never shows again.

'use client';

import { useState, useCallback } from 'react';

export function useFirstVisit() {
  const [showPopover, setShowPopover] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return !localStorage.getItem('discerned.seenHero'); } catch { return false; }
  });

  const dismiss = useCallback(() => {
    setShowPopover(false);
    try { localStorage.setItem('discerned.seenHero', '1'); } catch {}
  }, []);

  return { showPopover, dismiss };
}
