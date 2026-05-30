// Origin-pinned postMessage bridge between the Discerned Chrome extension and this page.
// The extension content script runs on discerned.online/* and announces itself with
// DISCERNED_BRIDGE_HELLO then pushes clips via DISCERNED_BRIDGE_CLIPS.
// On mount, the page posts DISCERNED_WEB_READY so the extension knows it can send.

import type { ClipData } from '@/lib/types';
import { LL, log } from '@/lib/logger';

export type BridgeMessage =
  | { type: 'DISCERNED_BRIDGE_HELLO'; pubkey: string | null; authMethod: 'nip07' | 'nip46' | 'nsec' | 'guest' | null }
  | { type: 'DISCERNED_BRIDGE_CLIPS'; clips: ClipData[] }
  | { type: 'DISCERNED_BRIDGE_NEW_CLIP'; clip: ClipData }
  | { type: 'DISCERNED_BRIDGE_FOCUS_CLIP'; clipId: string }
  | { type: 'DISCERNED_BRIDGE_CATEGORIES'; categories: string[] }
  | { type: 'DISCERNED_BRIDGE_CLIP_BODY'; id: string; bodyHtml?: string; thumbnail?: string | null };

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
