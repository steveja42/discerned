// Verifies the extension-routed signer's guards:
//   - identity mismatch (multi-identity wallet) → reject WITHOUT signing
//   - a locked wallet (signEvent never resolves) → reject after the timeout
//
// The modal subscribes via subscribeBridge, which is origin-pinned. jsdom's
// window.postMessage doesn't set MessageEvent.origin, so we dispatch a manually
// constructed MessageEvent with origin/source forged to the expected values
// (same technique as bridge.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { getPublicKey } from 'nostr-tools';

const sendSigned = vi.fn();
const sendRejected = vi.fn();

vi.mock('@/lib/bridge/extension-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge/extension-bridge')>();
  return {
    ...actual,
    sendSignedToExtension: (...args: unknown[]) => sendSigned(...args),
    sendSignRejectedToExtension: (...args: unknown[]) => sendRejected(...args),
  };
});

import PendingSignModal from '@/components/auth/PendingSignModal';

// Two real, distinct pubkeys so npubEncode succeeds in the rejection message.
const PUBKEY_A = getPublicKey(new Uint8Array(32).fill(1));
const PUBKEY_B = getPublicKey(new Uint8Array(32).fill(2));

function dispatchPendingSign(id: string, expectedPubkey?: string): void {
  const ev = new MessageEvent('message', {
    data: {
      type: 'DISCERNED_BRIDGE_PENDING_SIGN',
      id,
      event: { kind: 1, content: 'hello' },
      expectedPubkey,
    },
    origin: window.location.origin,
    source: window,
  });
  window.dispatchEvent(ev);
}

describe('PendingSignModal', () => {
  beforeEach(() => {
    sendSigned.mockClear();
    sendRejected.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { nostr?: unknown }).nostr;
    vi.useRealTimers();
  });

  it('blocks the sign when the wallet identity differs from expectedPubkey', async () => {
    const signEvent = vi.fn();
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: vi.fn().mockResolvedValue(PUBKEY_A), // active identity
      signEvent,
    };

    render(<PendingSignModal />);
    await act(async () => {
      dispatchPendingSign('sign_mismatch', PUBKEY_B); // connected as B, wallet is A
    });

    // Let the async getPublicKey resolve.
    await vi.waitFor(() => expect(sendRejected).toHaveBeenCalled());

    expect(signEvent).not.toHaveBeenCalled();
    const [id, message] = sendRejected.mock.calls[0];
    expect(id).toBe('sign_mismatch');
    expect(message).toMatch(/active as/i);
    expect(message).toMatch(/connected as/i);
    expect(sendSigned).not.toHaveBeenCalled();
  });

  it('signs when the wallet identity matches expectedPubkey', async () => {
    const signEvent = vi.fn().mockResolvedValue({ id: 'signed', sig: 'x' });
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: vi.fn().mockResolvedValue(PUBKEY_A),
      signEvent,
    };

    render(<PendingSignModal />);
    await act(async () => {
      dispatchPendingSign('sign_ok', PUBKEY_A);
    });

    await vi.waitFor(() => expect(sendSigned).toHaveBeenCalled());
    expect(signEvent).toHaveBeenCalledTimes(1);
    expect(sendRejected).not.toHaveBeenCalled();
  });

  it('translates a latched wallet into reload-the-tab guidance', async () => {
    // nos2x-style: after a cancelled prompt the wallet rejects every call.
    const latched = new Error('window.nostr call cancelled (rejecting further window.nostr calls until the next reload)');
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: vi.fn().mockResolvedValue(PUBKEY_A),
      signEvent: vi.fn().mockRejectedValue(latched),
    };

    render(<PendingSignModal />);
    await act(async () => {
      dispatchPendingSign('sign_latched', PUBKEY_A);
    });

    await vi.waitFor(() => expect(sendRejected).toHaveBeenCalled());
    const [id, message] = sendRejected.mock.calls[0];
    expect(id).toBe('sign_latched');
    expect(message).toMatch(/reload the discerned\.online tab/i);
    // The raw wallet string must not leak through to the overlay.
    expect(message).not.toMatch(/rejecting further/i);
    expect(sendSigned).not.toHaveBeenCalled();
  });

  it('translates a latched wallet that rejects getPublicKey', async () => {
    // The latch hits the identity guard first, before signEvent is ever reached.
    const latched = new Error('window.nostr call cancelled (rejecting further window.nostr calls until the next reload)');
    const signEvent = vi.fn();
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: vi.fn().mockRejectedValue(latched),
      signEvent,
    };

    render(<PendingSignModal />);
    await act(async () => {
      dispatchPendingSign('sign_latched_getpk', PUBKEY_A);
    });

    await vi.waitFor(() => expect(sendRejected).toHaveBeenCalled());
    expect(signEvent).not.toHaveBeenCalled();
    expect(sendRejected.mock.calls[0][1]).toMatch(/reload the discerned\.online tab/i);
  });

  it('rejects with a locked-wallet message when signEvent never resolves', async () => {
    vi.useFakeTimers();
    // signEvent that never settles (locked wallet).
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: vi.fn().mockResolvedValue(PUBKEY_A),
      signEvent: vi.fn(() => new Promise<never>(() => {})),
    };

    render(<PendingSignModal />);
    // Flush the getPublicKey/signEvent microtasks, then advance past the 30s cap.
    await act(async () => {
      dispatchPendingSign('sign_locked'); // no expectedPubkey → straight to signEvent
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(sendRejected).toHaveBeenCalledTimes(1);
    const [id, message] = sendRejected.mock.calls[0];
    expect(id).toBe('sign_locked');
    expect(message).toMatch(/locked/i);
    expect(sendSigned).not.toHaveBeenCalled();
  });
});
