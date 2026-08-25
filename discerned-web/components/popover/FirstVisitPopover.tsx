// Welcome popover anchored below the TopBar brand mark, shown on the first visit.
// Dismisses on outside pointerdown (listener deferred one tick to avoid the mount
// click triggering it immediately) or via the explicit action buttons.

'use client';

import { useEffect, useRef } from 'react';
import { PITCH } from '@/lib/marketing-copy';

interface FirstVisitPopoverProps {
  onDismiss: () => void;
  onLearnMore: () => void;
}

export default function FirstVisitPopover({ onDismiss, onLearnMore }: FirstVisitPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onDismiss]);

  return (
    <div ref={ref} className="brand-popover" role="dialog" aria-label="Welcome to Discerned">
      <div className="brand-popover-arrow" />
      <div className="brand-popover-eyebrow">Welcome</div>
      <div className="brand-popover-title">{PITCH.title} <em>{PITCH.titleEm}</em></div>
      <p className="brand-popover-lede">{PITCH.lede()}</p>
      <div className="brand-popover-actions">
        <button className="btn primary" onClick={onLearnMore}>Learn more →</button>
        <button className="btn ghost" onClick={onDismiss}>Got it</button>
      </div>
    </div>
  );
}
