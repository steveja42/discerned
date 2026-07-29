'use client';

import { useEffect } from 'react';
import type { BridgeMessage } from '@/lib/bridge/extension-bridge';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useClipStore } from '@/lib/bridge/ClipStoreContext';
import { applyRelayMode, applyRelayList } from '@/lib/constants';
import { LL, log } from '@/lib/logger';

export function useBridgeAuth() {
  const { setBridgeAuth } = useNostrAuth();
  // Read from the shared context so extensionPresent persists across navigation.
  // useLibraryBridge writes bridgePresent when the handshake succeeds; home page
  // reads it here without triggering any extra bridge sends.
  const { bridgePresent, setBridgePresent, setClips } = useClipStore();

  useEffect(() => {
    const t0 = performance.now();
    const elapsed = () => `+${Math.round(performance.now() - t0)}ms`;
    log(LL.DEBUG, '[useBridgeAuth] effect mounted', elapsed(),
        'document.readyState=', document.readyState,
        'visibilityState=', document.visibilityState);

    let gotHello = false;

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (!e.data || typeof e.data !== 'object') return;
      const msg = e.data as BridgeMessage;
      if (typeof msg.type !== 'string') return;
      if (!msg.type.startsWith('DISCERNED_BRIDGE_')) return;
      log(LL.DEBUG, '[useBridgeAuth] received', msg.type, elapsed());
      if (msg.type === 'DISCERNED_BRIDGE_HELLO') {
        gotHello = true;
        log(LL.DEBUG, '[useBridgeAuth] HELLO authMethod=', msg.authMethod, 'pubkey?=', !!msg.pubkey, elapsed());
        setBridgePresent(msg.pubkey, msg.authMethod);
        // Always forward the pubkey — including null. A HELLO with pubkey=null
        // means the extension signed out; setBridgeAuth clears a bridge-sourced
        // session so the sign-out propagates to this tab.
        setBridgeAuth(msg.pubkey);
      }
      if (msg.type === 'DISCERNED_BRIDGE_CLIPS') {
        setClips(msg.clips);
      }
      if (msg.type === 'DISCERNED_BRIDGE_RELAYS') {
        // Extension is source of truth for the dev relay mode — apply it so the
        // home-page feed re-subscribes to the same relay set the extension uses.
        applyRelayMode(msg.mode);
      }
      if (msg.type === 'DISCERNED_BRIDGE_RELAY_LIST') {
        // Same for the user's own relay list, so the public feed reads from the
        // relays they publish to.
        applyRelayList(msg.rows);
      }
    };
    window.addEventListener('message', onMessage);

    // On browser-restored tabs the extension's web-bridge content script
    // runs at document_idle, which can land well after React hydration —
    // sometimes 5+ seconds late. We ping DISCERNED_WEB_READY in a backoff
    // pattern and never give up entirely so even a very late-loading content
    // script will still hear us. The extension's handleReady is idempotent
    // (in-flight guard prevents duplicate sends).
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const ping = () => {
      timer = null;
      if (gotHello) return;
      window.postMessage({ type: 'DISCERNED_WEB_READY', clipCount: 0 }, window.location.origin);
      attempts++;
      log(LL.DEBUG, '[useBridgeAuth] ping #', attempts, elapsed());
      // 500ms for the first ~10 tries, then back off to every 2s. Cap at
      // 30 attempts (~50s) which covers any plausible content-script delay.
      const delay = attempts < 10 ? 500 : 2000;
      if (attempts < 30) {
        timer = setTimeout(ping, delay);
      } else {
        log(LL.WARN, '[useBridgeAuth] gave up after', attempts, 'pings without HELLO', elapsed());
      }
    };
    ping();

    const onVisible = () => {
      if (gotHello) return;
      attempts = 0;
      if (timer !== null) clearTimeout(timer);
      ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);

    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, [setBridgeAuth, setBridgePresent, setClips]);

  return { extensionPresent: bridgePresent };
}
