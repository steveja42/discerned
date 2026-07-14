// Verifies setBridgeAuth's transition rules (P6 — ext→web identity propagation):
//   - HELLO(null) clears a bridge-sourced session but leaves manual / connected alone
//   - HELLO(B) over a bridge-A session switches to B
//   - HELLO(B) over a wallet ('connected') session is ignored (wallet outranks)

import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { NostrAuthProvider, useNostrAuth } from '@/hooks/useNostrAuth';
import { getPublicKey } from 'nostr-tools';

const PUBKEY_A = getPublicKey(new Uint8Array(32).fill(1));
const PUBKEY_B = getPublicKey(new Uint8Array(32).fill(2));

// Captures the live context value so tests can call mutators and read state.
let ctx: ReturnType<typeof useNostrAuth>;
function Probe() {
  ctx = useNostrAuth();
  return null;
}

function renderProvider() {
  render(
    <NostrAuthProvider>
      <Probe />
    </NostrAuthProvider>,
  );
}

describe('setBridgeAuth transitions', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('adopts a bridge identity from a guest session', () => {
    renderProvider();
    act(() => ctx.setBridgeAuth(PUBKEY_A));
    expect(ctx.auth).toMatchObject({ status: 'readonly', pubkey: PUBKEY_A, source: 'bridge' });
  });

  it('switches a bridge session to a new identity', () => {
    renderProvider();
    act(() => ctx.setBridgeAuth(PUBKEY_A));
    act(() => ctx.setBridgeAuth(PUBKEY_B));
    expect(ctx.auth).toMatchObject({ pubkey: PUBKEY_B, source: 'bridge' });
  });

  it('clears a bridge session on HELLO(null) (extension sign-out)', () => {
    renderProvider();
    act(() => ctx.setBridgeAuth(PUBKEY_A));
    act(() => ctx.setBridgeAuth(null));
    expect(ctx.auth).toEqual({ status: 'guest', pubkey: null });
  });

  it('leaves a manual session untouched on HELLO(null)', () => {
    renderProvider();
    act(() => ctx.signInPubkey(PUBKEY_A)); // manual, readonly
    act(() => ctx.setBridgeAuth(null));
    expect(ctx.auth).toMatchObject({ pubkey: PUBKEY_A, source: 'manual' });
  });

  it('does not override a connected (wallet) session', () => {
    renderProvider();
    act(() => ctx.setNip07Connected(PUBKEY_A)); // connected via nip07
    act(() => ctx.setBridgeAuth(PUBKEY_B));
    expect(ctx.auth).toMatchObject({ status: 'connected', pubkey: PUBKEY_A, source: 'nip07' });
  });
});
