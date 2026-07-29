// Validates the origin-pinned postMessage contract between the extension's
// web-bridge content script and the web app. The web app must:
//   - ignore messages with the wrong origin
//   - ignore messages that don't start with DISCERNED_BRIDGE_
//   - post DISCERNED_WEB_READY back to its own window on mount
//   - dispatch matched DISCERNED_BRIDGE_* messages to the handler
//
// jsdom note: window.postMessage in jsdom doesn't populate MessageEvent.source
// or MessageEvent.origin the way real browsers do. listenForBridge rejects
// events on both grounds in production, so to exercise the happy path here we
// dispatch a manually-constructed MessageEvent with source/origin set to the
// values the bridge expects. The other tests (which assert non-delivery) use
// plain window.postMessage because the bridge correctly drops those either way.

import { describe, it, expect, vi } from 'vitest';
import { listenForBridge, sendRelayListToExtension, type BridgeMessage } from '@/lib/bridge/extension-bridge';

function dispatchBridgeEvent(payload: unknown): void {
  const ev = new MessageEvent('message', {
    data: payload,
    origin: window.location.origin,
    source: window,
  });
  window.dispatchEvent(ev);
}

describe('extension-bridge listener', () => {
  it('posts DISCERNED_WEB_READY immediately on subscribe', () => {
    const spy = vi.spyOn(window, 'postMessage');
    const cleanup = listenForBridge(() => {}, 5);
    expect(spy).toHaveBeenCalledWith(
      { type: 'DISCERNED_WEB_READY', clipCount: 5 },
      window.location.origin,
    );
    cleanup();
    spy.mockRestore();
  });

  it('invokes the handler for matched messages from the same origin', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);

    const helloMsg: BridgeMessage = {
      type: 'DISCERNED_BRIDGE_HELLO',
      pubkey: 'a'.repeat(64),
      authMethod: 'nip07',
    };
    dispatchBridgeEvent(helloMsg);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(helloMsg);

    cleanup();
  });

  it('delivers a PENDING_SIGN message carrying expectedPubkey', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);

    const pendingMsg: BridgeMessage = {
      type: 'DISCERNED_BRIDGE_PENDING_SIGN',
      id: 'sign_1',
      event: { kind: 1, content: 'hi' },
      expectedPubkey: 'a'.repeat(64),
    };
    dispatchBridgeEvent(pendingMsg);

    expect(handler).toHaveBeenCalledWith(pendingMsg);
    // expectedPubkey survives the round-trip so the modal can pre-check identity.
    expect(handler.mock.calls[0][0].expectedPubkey).toBe('a'.repeat(64));

    cleanup();
  });

  it('delivers the user relay list pushed by the extension', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);

    const relayMsg: BridgeMessage = {
      type: 'DISCERNED_BRIDGE_RELAY_LIST',
      rows: [
        { url: 'wss://relay.primal.net', source: 'default' },
        { url: 'wss://mine.example.com', source: 'discovered' },
      ],
    };
    dispatchBridgeEvent(relayMsg);

    expect(handler).toHaveBeenCalledWith(relayMsg);
    // The source badge survives so the settings UI can label discovered relays.
    expect(handler.mock.calls[0][0].rows[1].source).toBe('discovered');

    cleanup();
  });

  it('sends an edited relay list back to the extension', () => {
    const spy = vi.spyOn(window, 'postMessage');
    sendRelayListToExtension(['wss://mine.example.com'], ['wss://nos.lol']);
    expect(spy).toHaveBeenCalledWith(
      {
        type: 'DISCERNED_SET_RELAY_LIST',
        userRelays: ['wss://mine.example.com'],
        removedRelays: ['wss://nos.lol'],
      },
      window.location.origin,
    );
    spy.mockRestore();
  });

  it('ignores DISCERNED_WEB_READY echoes (own-side messages)', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);

    // listenForBridge fires DISCERNED_WEB_READY itself; the handler must not see
    // it because it does not start with DISCERNED_BRIDGE_. Even with source/origin
    // forged, this should be rejected on the type-prefix guard.
    dispatchBridgeEvent({ type: 'DISCERNED_WEB_READY', clipCount: 0 });
    expect(handler).not.toHaveBeenCalled();

    cleanup();
  });

  it('ignores messages whose type does not start with DISCERNED_BRIDGE_', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);

    dispatchBridgeEvent({ type: 'OTHER_THING', payload: 1 });
    expect(handler).not.toHaveBeenCalled();

    cleanup();
  });

  it('rejects messages whose origin does not match window.location.origin', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);

    const ev = new MessageEvent('message', {
      data: { type: 'DISCERNED_BRIDGE_HELLO', pubkey: null, authMethod: null },
      origin: 'https://evil.example.com',
      source: window,
    });
    window.dispatchEvent(ev);
    expect(handler).not.toHaveBeenCalled();

    cleanup();
  });

  it('detaches its event listener on cleanup', () => {
    const handler = vi.fn();
    const cleanup = listenForBridge(handler);
    cleanup();

    dispatchBridgeEvent({
      type: 'DISCERNED_BRIDGE_HELLO', pubkey: null, authMethod: null,
    } satisfies BridgeMessage);
    expect(handler).not.toHaveBeenCalled();
  });
});
