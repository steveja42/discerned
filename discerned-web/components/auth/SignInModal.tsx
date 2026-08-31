// Three-step sign-in modal: NIP-07 browser extension, paste nsec, or generate new keypair.
// Only the public key is ever stored (via storePubkey). The nsec is decoded in memory only
// and never persisted. The generated keypair flow requires the user to explicitly confirm
// they have backed up their key before continuing.

'use client';

import { useState } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { hasNip07, nip07GetPubkey, storePubkey } from '@/lib/nostr/auth';
import { sendPubkeyToExtension } from '@/lib/bridge/extension-bridge';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useOwnProfile } from '@/hooks/useOwnProfile';
import { authorLabel } from '@/lib/nostr/profiles';
import { LL, log } from '@/lib/logger';

interface SignInModalProps {
  onClose: () => void;
  onSignedIn?: (pubkey: string) => void;
  // Distinct from onSignedIn: a NIP-07 wallet sign-in yields a live signer, so
  // the session should become 'connected' (can cast), not the read-only state
  // that pasted-npub / nsec sign-ins produce. Callers wire this to signInNip07().
  // Falls back to onSignedIn when not provided.
  onNip07SignedIn?: (pubkey: string) => void;
}

type Step = 'account' | 'menu' | 'nsec' | 'generate';

export default function SignInModal({ onClose, onSignedIn, onNip07SignedIn }: SignInModalProps) {
  const { auth, signOut } = useNostrAuth();
  // Open on the account view when a session already exists; otherwise the menu.
  const [step, setStep] = useState<Step>(auth.pubkey ? 'account' : 'menu');
  const [nsecInput, setNsecInput] = useState('');
  const [error, setError] = useState('');
  const [nip07Busy, setNip07Busy] = useState(false);
  const [generated, setGenerated] = useState<{ nsec: string; pubkey: string } | null>(null);
  const nip07 = hasNip07();
  const ownProfile = useOwnProfile(auth.pubkey);
  const identityLabel = auth.pubkey ? authorLabel(auth.pubkey, ownProfile ?? undefined) : '';
  const npubFull = auth.pubkey ? npubEncode(auth.pubkey) : '';

  const handleNip07 = async () => {
    if (nip07Busy) return;
    setError('');
    setNip07Busy(true);
    // Locked wallets (Alby, nos2x) never resolve getPublicKey() until the user
    // unlocks — the call hangs with no rejection. Time out so the button can't
    // look permanently dead, and tell the user to unlock and retry.
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      setNip07Busy(false);
      setError('No response from your wallet. Is it unlocked? Unlock it, then try again.');
    }, 20_000);
    try {
      const pubkey = await nip07GetPubkey();
      if (settled) return; // timed out already — ignore the late resolve
      settled = true;
      clearTimeout(timeout);
      if (auth.pubkey && auth.pubkey !== pubkey) {
        log(LL.NORMAL, '[auth] identity switched:', npubEncode(auth.pubkey).slice(0, 12), '→', npubEncode(pubkey).slice(0, 12));
      }
      storePubkey(pubkey);
      // Share with the extension (if installed) so it can sign casts without
      // a second wallet approval. No-op when the extension isn't there.
      sendPubkeyToExtension(pubkey);
      (onNip07SignedIn ?? onSignedIn)?.(pubkey);
      onClose();
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      setNip07Busy(false);
      setError(e instanceof Error ? e.message : 'Your wallet declined or is unavailable. Is it unlocked?');
    }
  };

  const handleNsecSubmit = () => {
    try {
      const decoded = nip19Decode(nsecInput.trim());
      if (decoded.type !== 'nsec') { setError('Not a valid nsec key'); return; }
      const pubkey = getPublicKey(decoded.data as Uint8Array);
      onSignedIn?.(pubkey);
      onClose();
    } catch {
      setError('Invalid nsec key');
    }
  };

  const handleGenerate = () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const hex = Array.from(sk).map((b) => b.toString(16).padStart(2, '0')).join('');
    setGenerated({ nsec: `nsec1${hex}`, pubkey });
  };

  const confirmGenerate = () => {
    if (!generated) return;
    storePubkey(generated.pubkey);
    onSignedIn?.(generated.pubkey);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {step === 'account' && (
          <>
            <h2>Your <em>identity</em></h2>
            <div className="account-identity">
              <div className="account-name">{identityLabel}</div>
              <div className="account-npub">{npubFull}</div>
              <div className="account-status">
                {auth.status === 'connected' && auth.source === 'nip07'
                  ? 'Connected via signing extension — you can cast'
                  : auth.source === 'bridge'
                  ? 'Connected via your Discerned extension'
                  : 'Read-only — public key only, cannot cast'}
              </div>
            </div>

            <button
              className={`signin-method ${nip07 ? 'featured' : ''}`}
              onClick={handleNip07}
              disabled={!nip07 || nip07Busy}
            >
              <span className="glyph-mini">N</span>
              <div>
                <div className="label">Re-sign in with extension</div>
                <div className="sub">NIP-07 · {nip07Busy ? 'WAITING FOR WALLET…' : nip07 ? 'REFRESH OR SWITCH IDENTITY' : 'NOT FOUND'}</div>
              </div>
              <span className="arrow">{nip07Busy ? '…' : '→'}</span>
            </button>

            {error && <p className="error-note" role="alert">{error}</p>}

            <button className="signin-method" onClick={() => { setError(''); setStep('menu'); }}>
              <span className="glyph-mini" style={{ background: 'var(--paper-3)', color: 'var(--ink)' }}>⇄</span>
              <div>
                <div className="label">Sign in as a different user</div>
                <div className="sub">EXTENSION · NSEC · OR NEW IDENTITY</div>
              </div>
              <span className="arrow">→</span>
            </button>

            <button className="signin-method" onClick={() => { signOut(); onClose(); }}>
              <span className="glyph-mini" style={{ background: 'var(--paper-3)', color: 'var(--ink)' }}>⏻</span>
              <div>
                <div className="label">Sign out</div>
                <div className="sub">CLEAR THIS SESSION</div>
              </div>
              <span className="arrow">→</span>
            </button>
          </>
        )}

        {step === 'menu' && (
          <>
            <h2>Sign in with <em>your own keys</em></h2>
            <p className="lede">Discerned never holds your identity. Your reading is yours; we just help you organize it and, if you wish, broadcast it.</p>

            <button
              className={`signin-method ${nip07 ? 'featured' : ''}`}
              onClick={handleNip07}
              disabled={!nip07 || nip07Busy}
            >
              <span className="glyph-mini">N</span>
              <div>
                <div className="label">Use browser extension</div>
                <div className="sub">NIP-07 · {nip07Busy ? 'WAITING FOR WALLET…' : nip07 ? 'DETECTED' : 'NOT FOUND'}</div>
              </div>
              <span className="arrow">{nip07Busy ? '…' : '→'}</span>
            </button>

            {error && <p className="error-note" role="alert">{error}</p>}

            <button className="signin-method" onClick={() => setStep('nsec')}>
              <span className="glyph-mini" style={{ background: 'var(--paper-3)', color: 'var(--ink)' }}>K</span>
              <div>
                <div className="label">Paste private key</div>
                <div className="sub">NSEC · STORED IN SESSION ONLY</div>
              </div>
              <span className="arrow">→</span>
            </button>

            <button className="signin-method" onClick={() => { setStep('generate'); handleGenerate(); }}>
              <span className="glyph-mini" style={{ background: 'var(--paper-3)', color: 'var(--ink)' }}>+</span>
              <div>
                <div className="label">Create a new identity</div>
                <div className="sub">GENERATES KEYPAIR · YOU KEEP IT</div>
              </div>
              <span className="arrow">→</span>
            </button>

            <div className="modal-foot">
              <strong>Sovereign by default.</strong> Discerned cannot read your key.
              Casts are signed in your browser and sent to relays you choose. Export your data
              any time — it is plain JSON, portable to any Nostr client.
            </div>
          </>
        )}

        {step === 'nsec' && (
          <>
            <h2>Paste your <em>nsec key</em></h2>
            <p className="lede" style={{ color: 'oklch(0.50 0.14 25)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              ⚠ Warning: your key is never sent anywhere. It is used only in memory during this session.
            </p>
            <input
              type="password"
              placeholder="nsec1…"
              value={nsecInput}
              onChange={(e) => setNsecInput(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 7, background: 'var(--paper-2)', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)', outline: 'none', marginBottom: 12 }}
              autoComplete="off"
            />
            {error && <p className="error-note" role="alert">{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setStep('menu')}>← Back</button>
              <button className="btn primary" onClick={handleNsecSubmit}>Continue</button>
            </div>
          </>
        )}

        {step === 'generate' && generated && (
          <>
            <h2>Your new <em>identity</em></h2>
            <p className="lede">Back up your private key now — it cannot be recovered. Store it in a password manager.</p>
            <div style={{ background: 'var(--paper-3)', padding: '12px 14px', borderRadius: 8, fontFamily: 'var(--mono)', fontSize: 11, wordBreak: 'break-all', marginBottom: 16, color: 'var(--ink-2)', letterSpacing: '0.02em' }}>
              {generated.nsec}
            </div>
            {error && <p className="error-note" role="alert">{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setStep('menu')}>← Back</button>
              <button className="btn primary" onClick={confirmGenerate}>I&apos;ve saved it →</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
