// Right-click menu for a publisher's name/npub — Follow / Unfollow via the
// extension's NIP-02 kind:3 mutation (see hooks/useFollowMutation.ts). One
// shared instance is mounted per feed (see CastFeed.tsx); onContextMenu
// handlers on individual author spans/rows just report {pubkey,x,y} up to it.
// Dismisses on outside pointerdown or Escape, positioned at the cursor and
// clamped to the viewport (a right-click near the right/bottom edge would
// otherwise render off-screen).

'use client';

import { useEffect, useRef, useState } from 'react';

interface AuthorContextMenuProps {
  x: number;
  y: number;
  isFollowing: boolean;
  canFollow: boolean;
  disabledReason?: string;
  onFollow: () => void;
  onUnfollow: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 160;
const MENU_HEIGHT = 44;

export default function AuthorContextMenu({
  x,
  y,
  isFollowing,
  canFollow,
  disabledReason,
  onFollow,
  onUnfollow,
  onClose,
}: AuthorContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos] = useState(() => ({
    left: Math.min(x, window.innerWidth - MENU_WIDTH - 8),
    top: Math.min(y, window.innerHeight - MENU_HEIGHT - 8),
  }));

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Deferred one tick so the triggering contextmenu event's own pointerdown
    // (right-click) doesn't immediately dismiss the menu it just opened.
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="author-ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
    >
      <button
        className="author-ctx-menu-item"
        role="menuitem"
        disabled={!canFollow}
        title={!canFollow ? disabledReason : undefined}
        onClick={() => {
          if (isFollowing) onUnfollow();
          else onFollow();
          onClose();
        }}
      >
        {isFollowing ? 'Unfollow' : 'Follow'}
      </button>
    </div>
  );
}
