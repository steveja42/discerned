// Controls whether the first-visit welcome popover is shown.
// State is derived from localStorage["discerned.seenHero"] — present means dismissed.
// Calling dismiss() hides the popover and writes the flag so it never shows again.

'use client';

import { useState, useEffect, useCallback } from 'react';

export function useFirstVisit() {
  // Start false so the first client render matches the server (which has no
  // localStorage). The flag is read after mount to avoid a hydration mismatch.
  const [showPopover, setShowPopover] = useState(false);

  useEffect(() => {
    try { setShowPopover(!localStorage.getItem('discerned.seenHero')); } catch {}
  }, []);

  const dismiss = useCallback(() => {
    setShowPopover(false);
    try { localStorage.setItem('discerned.seenHero', '1'); } catch {}
  }, []);

  return { showPopover, dismiss };
}
