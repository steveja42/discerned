// Role: Content Script — MAIN world NIP-07 bridge
// Description: Injected into the page's MAIN world (not the isolated content-script sandbox)
//              so it can reach window.nostr. Proxies getPublicKey and signEvent calls
//              to/from auth.ts in the content script via postMessage.
// Access: window.nostr (NIP-07 browser wallet), window.postMessage (same-origin bridge)

export {}; // Makes this a module so declare global is valid

// ── Overlay click-capture guard ───────────────────────────────────────────────
// Some sites register capture-phase click listeners on document/window that call
// window.open() before any bubble-phase stopPropagation() inside the shadow DOM
// can fire. By overriding window.open here (document_start, MAIN world, before
// any page script runs) we prevent tabs from opening while our overlay is active.
const _origOpen = window.open.bind(window);
window.open = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
  if (document.querySelector('discerned-overlay')) return null;
  return _origOpen(url, target, features);
};

interface NostrProvider {
  getPublicKey(): Promise<string>;
  signEvent(event: object): Promise<object>;
}

declare global {
  interface Window {
    nostr?: NostrProvider;
  }
}

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window) return;
  const type: unknown = event.data?.type;
  if (typeof type !== 'string' || !type.startsWith('DISCERNED_NIP07_')) return;

  if (type === 'DISCERNED_NIP07_CHECK') {
    window.postMessage({
      type: 'DISCERNED_NIP07_CHECK_RESPONSE',
      hasNostr: typeof window.nostr !== 'undefined',
    }, '*');
    return;
  }

  if (type === 'DISCERNED_NIP07_PUBKEY') {
    try {
      const pubkey = await window.nostr!.getPublicKey();
      window.postMessage({ type: 'DISCERNED_NIP07_PUBKEY_RESPONSE', pubkey }, '*');
    } catch (err) {
      window.postMessage({
        type: 'DISCERNED_NIP07_PUBKEY_RESPONSE',
        error: (err as Error).message,
      }, '*');
    }
    return;
  }

  if (type === 'DISCERNED_NIP07_SIGN') {
    try {
      const signed = await window.nostr!.signEvent(event.data.event as object);
      window.postMessage({
        type: 'DISCERNED_NIP07_SIGN_RESPONSE',
        id: event.data.id as string,
        signed,
      }, '*');
    } catch (err) {
      window.postMessage({
        type: 'DISCERNED_NIP07_SIGN_RESPONSE',
        id: event.data.id as string,
        error: (err as Error).message,
      }, '*');
    }
  }
});
