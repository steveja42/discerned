'use client';

// NIP-07 signer for extension-routed casts.
// The extension always signs kind-1 events on discerned.online so the wallet
// only ever needs to approve this origin once. While a sign is in flight a small
// banner is shown ("approve in your signing extension…"), because a locked
// wallet may never surface its prompt. Three failure paths are guarded:
//   - no window.nostr → reject immediately
//   - the wallet's active identity ≠ the identity the extension connected as
//     (multi-identity wallets) → reject WITHOUT signing, naming both identities
//   - the wallet never responds (locked) → reject after a 30s timeout
// 30s is below the extension's 120s pending-sign timeout, so the specific
// web-side message always reaches the user before the generic one.

import { useEffect, useState } from 'react';
import { npubEncode } from 'nostr-tools/nip19';
import { subscribeBridge, sendSignedToExtension, sendSignRejectedToExtension } from '@/lib/bridge/extension-bridge';
import { LL, log } from '@/lib/logger';

const SIGN_TIMEOUT_MS = 30_000;

// Some wallets (nos2x and relatives) latch into a "cancelled" state after a
// dismissed or stuck approval popup and then reject EVERY subsequent
// window.nostr call on this page without prompting. The flag lives in the
// injected window.nostr's closure, which is page-scoped — so only a reload of
// the signing tab clears it. Retrying from the extension can't:
// signEventViaWebApp reuses that same tab, hence the same poisoned
// window.nostr. Detect it and say what actually works instead of surfacing the
// raw wallet string.
const WALLET_LATCHED_RE = /rejecting further|until the next reload/i;

// "the discerned.online tab", not "this tab" — this message is relayed back to
// the extension and shown in the overlay on the page being cast, which is a
// DIFFERENT tab from the signing tab the user needs to reload.
const WALLET_LATCHED_MESSAGE =
  'Your signing extension is refusing further requests after a cancelled prompt. '
  + 'Reload the discerned.online tab, then cast again.';

function npubShort(pk: string): string {
  try { return `${npubEncode(pk).slice(0, 12)}…`; } catch { return `${pk.slice(0, 12)}…`; }
}

function describeSignError(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  if (WALLET_LATCHED_RE.test(raw)) return WALLET_LATCHED_MESSAGE;
  return raw || 'Wallet rejected the sign';
}

export default function PendingSignModal() {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const cleanup = subscribeBridge(async (msg) => {
      if (msg.type !== 'DISCERNED_BRIDGE_PENDING_SIGN') return;
      const { id, event, expectedPubkey } = msg;
      if (!window.nostr) {
        sendSignRejectedToExtension(id, 'NIP-07 extension not available');
        return;
      }

      setPending(true);
      // Locked wallets never resolve getPublicKey()/signEvent() until unlocked —
      // the call hangs with no rejection. Cap the whole sequence so the cast
      // can't silently stall for the extension's full 2-minute timeout.
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        setPending(false);
        sendSignRejectedToExtension(id, 'Your signing extension did not respond — it may be locked. Unlock it and try casting again.');
      }, SIGN_TIMEOUT_MS);

      try {
        // Guard multi-identity wallets: if the wallet's active identity differs
        // from the one the extension connected as, the event would be signed by
        // the wrong key (or rejected as a mismatch). Block it and explain.
        if (expectedPubkey) {
          const active = await window.nostr.getPublicKey();
          if (settled) return;
          if (active !== expectedPubkey) {
            settled = true;
            clearTimeout(timeout);
            setPending(false);
            log(LL.WARN, '[pending-sign] identity mismatch — active', npubShort(active), 'expected', npubShort(expectedPubkey));
            sendSignRejectedToExtension(
              id,
              `Your signing extension is active as ${npubShort(active)} but you connected as ${npubShort(expectedPubkey)}. Switch identity in your wallet, or sign in again at discerned.online to cast as the new identity.`,
            );
            return;
          }
        }

        const signed = await window.nostr.signEvent(event);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        setPending(false);
        sendSignedToExtension(id, signed);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        setPending(false);
        // Covers both window.nostr calls above — a latched wallet rejects
        // getPublicKey() just as readily as signEvent().
        sendSignRejectedToExtension(id, describeSignError(err));
      }
    });
    return cleanup;
  }, []);

  if (!pending) return null;

  return (
    <div className="pending-sign-banner" role="status" aria-live="polite">
      <span className="pending-sign-spinner" aria-hidden="true" />
      <span>Approve the signature in your signing extension… If nothing appears, unlock your wallet.</span>
    </div>
  );
}
