// Role: Content Script — MAIN world NIP-07 bridge
// Description: Injected into the page's MAIN world (not the isolated content-script sandbox)
//              so it can reach window.nostr. Proxies getPublicKey and signEvent calls
//              to/from auth.ts in the content script via postMessage.
// Access: window.nostr (NIP-07 browser wallet), window.postMessage (same-origin bridge)

export {}; // Makes this a module so declare global is valid

interface NostrProvider {
  getPublicKey(): Promise<string>;
  signEvent(event: object): Promise<object>;
  // Optional in NIP-07 — several wallets don't implement it, so every call site
  // must feature-detect before invoking.
  getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>;
}

declare global {
  interface Window {
    nostr?: NostrProvider;
    __discernedNip07BridgeLoaded?: boolean;
  }
}

// Injected on demand (chrome.scripting.executeScript, MAIN world), so one page can
// receive this script more than once. Re-running would chain a second window.open
// wrapper around the first and add a duplicate message listener, so the install
// runs only on the first injection into a given page.
if (!window.__discernedNip07BridgeLoaded) {
  window.__discernedNip07BridgeLoaded = true;
  installNip07Bridge();
}

function installNip07Bridge(): void {

// ── Overlay click-capture guard ───────────────────────────────────────────────
// Some sites register capture-phase click listeners on document/window that call
// window.open() before any bubble-phase stopPropagation() inside the shadow DOM
// can fire. Overriding window.open prevents tabs from opening while our overlay
// is active. Installed on activation (not document_start) — it intercepts the
// CALL, so it only has to be in place before the user's next click, and the
// background awaits this injection before the overlay is rendered.
const _origOpen = window.open.bind(window);
window.open = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
  if (document.querySelector('#discerned-overlay')) return null;
  return _origOpen(url, target, features);
};

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

  if (type === 'DISCERNED_NIP07_GETRELAYS') {
    // getRelays is OPTIONAL in NIP-07. An absent implementation is a normal
    // outcome, not an error — respond with an empty map so the caller falls
    // through quietly instead of waiting out its timeout.
    if (typeof window.nostr?.getRelays !== 'function') {
      window.postMessage({ type: 'DISCERNED_NIP07_GETRELAYS_RESPONSE', relays: {} }, '*');
      return;
    }
    try {
      const relays = await window.nostr.getRelays();
      window.postMessage({ type: 'DISCERNED_NIP07_GETRELAYS_RESPONSE', relays }, '*');
    } catch (err) {
      window.postMessage({
        type: 'DISCERNED_NIP07_GETRELAYS_RESPONSE',
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

}
