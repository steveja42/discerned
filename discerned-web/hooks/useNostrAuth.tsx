// Global Nostr authentication state, shared via React context so every
// consumer (HomeClient, TopBar wrappers, useBridgeAuth, etc.) sees the same
// auth instance. The home page should sign in via NIP-07 (window.nostr) on
// its own — the extension bridge is only a presence indicator.
//
// On mount the provider:
//   - Restores any pubkey persisted to localStorage as readonly.
//   - Polls for window.nostr (MV3 content scripts can inject after hydration
//     on browser-restored tabs).
//   - When window.nostr appears, calls getPublicKey() and upgrades to
//     'connected', persisting the pubkey for future loads.

'use client';

import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react';
import type { AuthState } from '@/lib/types';
import { loadStoredPubkey, storePubkey, clearStoredAuth, hasNip07, nip07GetPubkey } from '@/lib/nostr/auth';
import { sendPubkeyToExtension } from '@/lib/bridge/extension-bridge';
import { LL, log } from '@/lib/logger';

interface NostrAuthValue {
  auth: AuthState;
  nip07Available: boolean;
  signInNip07: () => Promise<void>;
  signInPubkey: (pubkey: string) => void;
  signOut: () => void;
  setBridgeAuth: (pubkey: string | null) => void;
}

const NostrAuthContext = createContext<NostrAuthValue | null>(null);

export function NostrAuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'guest', pubkey: null });
  const [nip07Available, setNip07Available] = useState(false);

  useLayoutEffect(() => {
    const stored = loadStoredPubkey();
    if (stored) setAuth({ status: 'readonly', pubkey: stored, source: 'manual' });
  }, []);

  useEffect(() => {
    const t0 = performance.now();
    const elapsed = () => `+${Math.round(performance.now() - t0)}ms`;
    log(LL.DEBUG, '[useNostrAuth] effect mounted', elapsed(),
        'readyState=', document.readyState,
        'hasNip07=', hasNip07());

    let cancelled = false;
    let signedIn = false;

    const autoSigninRequested = new URLSearchParams(window.location.search).get('signin') === '1';

    // Probes window.nostr without prompting. Just marks the wallet as available
    // so the Sign In button appears — does NOT call getPublicKey() automatically.
    // Wallets like Alby open a blank unresponsive popup when getPublicKey() is
    // called programmatically on a not-yet-approved origin. The user must click
    // Sign In first; after that first approval the wallet caches the permission
    // and all future auto-probes on this origin are silent.
    // Exception: when ?signin=1 is in the URL (set by the extension's "Open web app"
    // button), we automatically call signInNip07() — the user's explicit click on
    // the extension button is the gesture that justifies the auto-sign.
    const probe = () => {
      if (cancelled || signedIn) return;
      if (!hasNip07()) return;
      log(LL.DEBUG, '[useNostrAuth] probe: window.nostr present', elapsed());
      setNip07Available(true);
      if (autoSigninRequested) {
        log(LL.DEBUG, '[useNostrAuth] ?signin=1 detected — auto-calling signInNip07', elapsed());
        signedIn = true;
        nip07GetPubkey().then((pubkey) => {
          if (cancelled) return;
          storePubkey(pubkey);
          setAuth({ status: 'connected', pubkey, source: 'nip07' });
          sendPubkeyToExtension(pubkey);
        }).catch((err: unknown) => {
          log(LL.WARN, '[useNostrAuth] auto-signin failed:', err instanceof Error ? err.message : String(err));
        });
      }
    };

    // Defer the probe until after the page has finished loading. On browser
    // launch with restored tabs, the wallet's MAIN-world content script may
    // not have injected window.nostr yet during hydration; probing during the
    // commit phase can race against the wallet's own init. Waiting for `load`
    // (plus a polling fallback) gives the wallet time to settle.
    let attempts = 0;
    const MAX_ATTEMPTS = 30; // ~9 s at 300 ms

    const poll = () => {
      if (cancelled || signedIn) return;
      const present = hasNip07();
      if (attempts === 0 || attempts % 5 === 0) {
        log(LL.DEBUG, '[useNostrAuth] poll #', attempts, 'hasNip07=', present, elapsed());
      }
      if (present) {
        probe();
        return;
      }
      if (++attempts < MAX_ATTEMPTS) {
        setTimeout(poll, 300);
      } else {
        log(LL.WARN, '[useNostrAuth] gave up polling for window.nostr', elapsed());
      }
    };

    const startProbing = () => {
      log(LL.DEBUG, '[useNostrAuth] startProbing scheduled', elapsed());
      // requestIdleCallback gives the browser a chance to flush layout and
      // wallet init before we touch window.nostr. Falls back to setTimeout
      // for browsers without it.
      const start = () => poll();
      if ('requestIdleCallback' in window) {
        (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number })
          .requestIdleCallback(start, { timeout: 500 });
      } else {
        setTimeout(start, 100);
      }
    };

    if (document.readyState === 'complete') {
      log(LL.DEBUG, '[useNostrAuth] readyState already complete; probing immediately', elapsed());
      startProbing();
    } else {
      log(LL.DEBUG, '[useNostrAuth] waiting for load event before probing', elapsed());
      window.addEventListener('load', startProbing, { once: true });
    }

    const onVisible = () => { attempts = 0; poll(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);

    return () => {
      cancelled = true;
      window.removeEventListener('load', startProbing);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, []);

  const signInNip07 = useCallback(async () => {
    const pubkey = await nip07GetPubkey();
    storePubkey(pubkey);
    setAuth({ status: 'connected', pubkey, source: 'nip07' });
    // Share the pubkey with the extension (if installed) so it can sign
    // future casts without reprompting. No-op when the extension isn't there.
    sendPubkeyToExtension(pubkey);
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
    setAuth((prev) => {
      if (prev.status === 'connected') {
        log(LL.DEBUG, '[useNostrAuth] setBridgeAuth ignored — already connected');
        return prev;
      }
      log(LL.DEBUG, '[useNostrAuth] setBridgeAuth → readonly/bridge');
      return { status: 'readonly', pubkey, source: 'bridge' };
    });
  }, []);

  return (
    <NostrAuthContext.Provider value={{ auth, nip07Available, signInNip07, signInPubkey, signOut, setBridgeAuth }}>
      {children}
    </NostrAuthContext.Provider>
  );
}

export function useNostrAuth(): NostrAuthValue {
  const ctx = useContext(NostrAuthContext);
  if (!ctx) {
    throw new Error('useNostrAuth must be used inside <NostrAuthProvider>');
  }
  return ctx;
}
