// Topbar avatar button reflecting the current auth status.
// Guest shows "N" (Nostr); connected/readonly shows the first two chars of the pubkey.
// Clicking always opens the sign-in modal regardless of current status.

'use client';

import type { AuthState } from '@/lib/types';

interface AuthAvatarProps {
  auth: AuthState;
  onClick: () => void;
}

export default function AuthAvatar({ auth, onClick }: AuthAvatarProps) {
  const label = auth.pubkey ? auth.pubkey.slice(0, 2).toUpperCase() : 'N';
  const title = auth.status === 'guest'
    ? 'Sign in with Nostr'
    : auth.status === 'connected'
      ? `Connected · ${auth.pubkey?.slice(0, 8)}…`
      : `Read-only · ${auth.pubkey?.slice(0, 8)}…`;

  return (
    <button
      className="avatar"
      onClick={onClick}
      title={title}
      style={auth.status !== 'guest' ? { background: 'var(--accent)', color: '#fff' } : undefined}
    >
      {label}
    </button>
  );
}
