'use client';

// Silent NIP-07 signer for extension-routed casts.
// The extension always signs kind-1 events on discerned.online so the wallet
// only ever needs to approve this origin once. No UI is shown — the sign
// happens automatically when the request arrives. If the wallet is locked or
// rejects, the error is forwarded back to the extension.

import { useEffect } from 'react';
import { subscribeBridge, sendSignedToExtension, sendSignRejectedToExtension } from '@/lib/bridge/extension-bridge';

export default function PendingSignModal() {
  useEffect(() => {
    const cleanup = subscribeBridge(async (msg) => {
      if (msg.type !== 'DISCERNED_BRIDGE_PENDING_SIGN') return;
      const { id, event } = msg;
      if (!window.nostr) {
        sendSignRejectedToExtension(id, 'NIP-07 extension not available');
        return;
      }
      try {
        const signed = await window.nostr.signEvent(event);
        sendSignedToExtension(id, signed);
      } catch (err) {
        sendSignRejectedToExtension(id, err instanceof Error ? err.message : 'Wallet rejected the sign');
      }
    });
    return cleanup;
  }, []);

  return null;
}
