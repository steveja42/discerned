// Origin-pinned postMessage bridge between the Discerned Chrome extension and this page.
// The extension content script runs on discerned.online/* and announces itself with
// DISCERNED_BRIDGE_HELLO then pushes clips via DISCERNED_BRIDGE_CLIPS.
// On mount, the page posts DISCERNED_WEB_READY so the extension knows it can send.

import type { ClipData } from '@/lib/types';
import type { RelayMode, RelayRow } from '@/lib/constants';
import { LL, log } from '@/lib/logger';

export type BridgeMessage =
  | { type: 'DISCERNED_BRIDGE_HELLO'; pubkey: string | null; authMethod: 'nip07' | 'nip46' | 'nsec' | 'guest' | null }
  | { type: 'DISCERNED_BRIDGE_CLIPS'; clips: ClipData[] }
  | { type: 'DISCERNED_BRIDGE_NEW_CLIP'; clip: ClipData }
  | { type: 'DISCERNED_BRIDGE_FOCUS_CLIP'; clipId: string }
  | { type: 'DISCERNED_BRIDGE_CATEGORIES'; categories: string[] }
  | { type: 'DISCERNED_BRIDGE_CLIP_BODY'; id: string; bodyHtml?: string; thumbnail?: string | null }
  | { type: 'DISCERNED_BRIDGE_PENDING_SIGN'; id: string; event: Record<string, unknown>; expectedPubkey?: string }
  | { type: 'DISCERNED_BRIDGE_RELAYS'; mode: RelayMode }
  | { type: 'DISCERNED_BRIDGE_RELAY_LIST'; rows: RelayRow[] }
  | { type: 'DISCERNED_BRIDGE_FOLLOW_RESULT'; pubkey: string; following: boolean; ok: boolean; error?: string };

export function listenForBridge(
  handler: (msg: BridgeMessage) => void,
  clipCount = 0,
): () => void {
  const t0 = performance.now();
  const elapsed = () => `+${Math.round(performance.now() - t0)}ms`;
  log(LL.DEBUG, '[listenForBridge] subscribe', elapsed(), 'clipCount=', clipCount);

  let gotHello = false;

  const onMessage = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || typeof e.data !== 'object') return;
    if (typeof e.data.type !== 'string') return;
    if (!e.data.type.startsWith('DISCERNED_BRIDGE_')) return;
    const msg = e.data as BridgeMessage;
    log(LL.DEBUG, '[listenForBridge] received', msg.type, elapsed());
    if (msg.type === 'DISCERNED_BRIDGE_HELLO') gotHello = true;
    handler(msg);
  };
  window.addEventListener('message', onMessage);

  // Retry DISCERNED_WEB_READY until HELLO arrives. On browser-restored tabs
  // the extension's web-bridge content script can attach its own message
  // listener well after this page hydrates, so a single READY can be lost.
  // The extension's handleReady is idempotent, so retries are safe.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const ping = () => {
    timer = null;
    if (gotHello) return;
    window.postMessage({ type: 'DISCERNED_WEB_READY', clipCount }, window.location.origin);
    attempts++;
    log(LL.DEBUG, '[listenForBridge] ping #', attempts, elapsed());
    const delay = attempts < 10 ? 500 : 2000;
    if (attempts < 30) {
      timer = setTimeout(ping, delay);
    } else {
      log(LL.WARN, '[listenForBridge] gave up after', attempts, 'pings without HELLO', elapsed());
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
}

// Like listenForBridge but does NOT send DISCERNED_WEB_READY pings — just
// attaches a message listener. Use this for globally-mounted listeners (e.g.
// the PendingSignModal in the root layout) that piggyback on the page-level
// listenForBridge's ping/HELLO handshake rather than triggering their own.
export function subscribeBridge(handler: (msg: BridgeMessage) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || typeof e.data !== 'object') return;
    if (typeof e.data.type !== 'string') return;
    if (!e.data.type.startsWith('DISCERNED_BRIDGE_')) return;
    handler(e.data as BridgeMessage);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

export function sendDeleteClips(ids: string[]): void {
  window.postMessage({ type: 'DISCERNED_DELETE_CLIPS', ids }, window.location.origin);
}

export function sendUpdateNote(id: string, note: string): void {
  window.postMessage({ type: 'DISCERNED_UPDATE_NOTE', id, note }, window.location.origin);
}

export function sendImportClips(clips: ClipData[]): void {
  window.postMessage({ type: 'DISCERNED_IMPORT_CLIPS', clips }, window.location.origin);
}

export function sendUpdateCategories(categories: string[]): void {
  window.postMessage({ type: 'DISCERNED_UPDATE_CATEGORIES', categories }, window.location.origin);
}

export function requestClipBody(id: string): void {
  window.postMessage({ type: 'DISCERNED_REQUEST_CLIP_BODY', id }, window.location.origin);
}

// Forward a freshly-acquired NIP-07 pubkey to the extension after the user
// signs in on the web app. Best-effort: no-op when the extension isn't
// installed, since postMessage to the same origin will simply find no
// matching content-script listener. The user's gesture (Sign In click) on a
// discerned origin is what sanctions the extension adopting this identity.
export function sendPubkeyToExtension(pubkey: string): void {
  window.postMessage({ type: 'DISCERNED_SET_NIP07_PUBKEY', pubkey }, window.location.origin);
}

// Send the signed event back to the extension after the user confirms a
// pending cast in the web app. The id matches the one delivered in
// DISCERNED_BRIDGE_PENDING_SIGN.
export function sendSignedToExtension(id: string, signed: Record<string, unknown>): void {
  window.postMessage({ type: 'DISCERNED_SIGNED', id, signed }, window.location.origin);
}

// Tell the extension the user declined or the wallet rejected the sign.
export function sendSignRejectedToExtension(id: string, error: string): void {
  window.postMessage({ type: 'DISCERNED_SIGN_REJECTED', id, error }, window.location.origin);
}

// Push a relay-mode change from the web app's own dev toggle to the extension,
// which persists it (the extension is the canonical store) and re-broadcasts it
// to any other open tabs. No-op when the extension isn't installed.
export function sendRelayModeToExtension(mode: RelayMode): void {
  window.postMessage({ type: 'DISCERNED_SET_RELAY_MODE', mode }, window.location.origin);
}

// Push an edited relay list to the extension, which normalises + persists it
// (it is the canonical store) and re-broadcasts the result to every open tab.
// `userRelays` are the relays the user added or had discovered; `removedRelays`
// are the ones they dropped, including built-in defaults. No-op when the
// extension isn't installed — the web app keeps its own localStorage copy.
export function sendRelayListToExtension(userRelays: string[], removedRelays: string[]): void {
  window.postMessage(
    { type: 'DISCERNED_SET_RELAY_LIST', userRelays, removedRelays },
    window.location.origin,
  );
}

// Ask the extension to publish a NIP-02 kind:3 follow/unfollow for `pubkey`.
// The extension fetches the signed-in user's current contact list fresh,
// mutates just this one entry, signs, and publishes it, then broadcasts the
// outcome back as DISCERNED_BRIDGE_FOLLOW_RESULT. No-op when the extension
// isn't installed — callers must check bridge presence before offering Follow.
export function sendFollowPubkeyToExtension(pubkey: string): void {
  window.postMessage({ type: 'DISCERNED_FOLLOW_PUBKEY', pubkey }, window.location.origin);
}

export function sendUnfollowPubkeyToExtension(pubkey: string): void {
  window.postMessage({ type: 'DISCERNED_UNFOLLOW_PUBKEY', pubkey }, window.location.origin);
}
