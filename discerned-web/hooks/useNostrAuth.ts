// Global Nostr authentication state for the app.
// On mount, restores a previously stored pubkey from localStorage.
// Exposes sign-in methods for NIP-07, pubkey-only (read-only), and bridge auth.
// Bridge auth never upgrades an already-connected session.

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { AuthState } from '@/lib/types';
import { loadStoredPubkey, storePubkey, clearStoredAuth, hasNip07, nip07GetPubkey } from '@/lib/nostr/auth';

export function useNostrAuth() {
  const [auth, setAuth] = useState<AuthState>({ status: 'guest', pubkey: null });
  const [nip07Available, setNip07Available] = useState(false);

  useEffect(() => {
    setNip07Available(hasNip07());
    const pubkey = loadStoredPubkey();
    if (pubkey) {
      setAuth({ status: hasNip07() ? 'connected' : 'readonly', pubkey, source: 'manual' });
    }
  }, []);

  const signInNip07 = useCallback(async () => {
    const pubkey = await nip07GetPubkey();
    storePubkey(pubkey);
    setAuth({ status: 'connected', pubkey, source: 'nip07' });
  }, []);

  const signInPubkey = useCallback((pubkey: string) => {
    storePubkey(pubkey);
    setAuth({ status: 'readonly', pubkey, source: 'manual' });
  }, []);

  const signOut = useCallback(() => {
    clearStoredAuth();
    setAuth({ status: 'guest', pubkey: null });
  }, []);

  const setBridgeAuth = useCallback((pubkey: string | null) => {
    if (!pubkey) return;
    setAuth((prev) =>
      prev.status === 'connected' ? prev : { status: 'readonly', pubkey, source: 'bridge' },
    );
  }, []);

  return { auth, nip07Available, signInNip07, signInPubkey, signOut, setBridgeAuth };
}
