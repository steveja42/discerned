// Three-step sign-in modal: NIP-07 browser extension, paste nsec, or generate new keypair.
// Only the public key is ever stored (via storePubkey). The nsec is decoded in memory only
// and never persisted. The generated keypair flow requires the user to explicitly confirm
// they have backed up their key before continuing.

'use client';

import { useState } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import { hasNip07, nip07GetPubkey, storePubkey } from '@/lib/nostr/auth';

interface SignInModalProps {
  onClose: () => void;
  onSignedIn?: (pubkey: string) => void;
}

type Step = 'menu' | 'nsec' | 'generate';

export default function SignInModal({ onClose, onSignedIn }: SignInModalProps) {
  const [step, setStep] = useState<Step>('menu');
  const [nsecInput, setNsecInput] = useState('');
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<{ nsec: string; pubkey: string } | null>(null);
  const nip07 = hasNip07();

  const handleNip07 = async () => {
    try {
      const pubkey = await nip07GetPubkey();
      storePubkey(pubkey);
      onSignedIn?.(pubkey);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extension error');
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

        {step === 'menu' && (
          <>
            <h2>Sign in with <em>your own keys</em></h2>
            <p className="lede">Discerned never holds your identity. Your reading is yours; we just help you organize it and, if you wish, broadcast it.</p>

            <button
              className={`signin-method ${nip07 ? 'featured' : ''}`}
              onClick={handleNip07}
              disabled={!nip07}
            >
              <span className="glyph-mini">N</span>
              <div>
                <div className="label">Use browser extension</div>
                <div className="sub">NIP-07 · {nip07 ? 'DETECTED' : 'NOT FOUND'}</div>
              </div>
              <span className="arrow">→</span>
            </button>

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
            {error && <p style={{ color: 'oklch(0.50 0.14 25)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 12 }}>{error}</p>}
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
            {error && <p style={{ color: 'oklch(0.50 0.14 25)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 12 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setStep('menu')}>← Back</button>
              <button className="btn primary" onClick={confirmGenerate}>I've saved it →</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
