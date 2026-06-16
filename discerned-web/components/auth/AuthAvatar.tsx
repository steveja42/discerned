// Topbar avatar button reflecting the current auth status.
// Guest shows "N" (Nostr); connected/readonly shows the first two npub chars.
// Clicking always opens the sign-in modal regardless of current status.

'use client';

import { npubEncode } from 'nostr-tools/nip19';
import type { AuthState } from '@/lib/types';

interface AuthAvatarProps {
  auth: AuthState;
  onClick: () => void;
}

export default function AuthAvatar({ auth, onClick }: AuthAvatarProps) {
  const npub = auth.pubkey ? npubEncode(auth.pubkey) : null;
  // Skip the shared "npub1" prefix so the monogram reflects the unique part of the key.
  const label = npub ? npub.slice(5, 7).toUpperCase() : 'N';
  const title = auth.status === 'guest'
    ? 'Sign in with Nostr'
    : auth.status === 'connected'
      ? `Connected · ${npub?.slice(0, 12)}…`
      : `Read-only · ${npub?.slice(0, 12)}…`;

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
