'use client';

import { useEffect } from 'react';
import type { BridgeMessage } from '@/lib/bridge/extension-bridge';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useClipStore } from '@/lib/bridge/ClipStoreContext';

export function useBridgeAuth() {
  const { setBridgeAuth } = useNostrAuth();
  // Read from the shared context so extensionPresent persists across navigation.
  // useLibraryBridge writes bridgePresent when the handshake succeeds; home page
  // reads it here without triggering any extra bridge sends.
  const { bridgePresent, setBridgePresent, setClips } = useClipStore();

  useEffect(() => {
    // Listen passively — do NOT post DISCERNED_WEB_READY here. That signal is
    // sent only by useLibraryBridge so the extension knows the clip count and
    // can skip redundant sends. useBridgeAuth handles HELLO and CLIPS so the
    // store is populated even when the bridge fires on a non-library page.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.source !== window) return;
      if (!e.data || typeof e.data !== 'object') return;
      const msg = e.data as BridgeMessage;
      if (msg.type === 'DISCERNED_BRIDGE_HELLO') {
        setBridgePresent(msg.pubkey, msg.authMethod);
        if (msg.pubkey) setBridgeAuth(msg.pubkey);
      }
      if (msg.type === 'DISCERNED_BRIDGE_CLIPS') {
        setClips(msg.clips);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [setBridgeAuth, setBridgePresent, setClips]);

  return { extensionPresent: bridgePresent };
}
