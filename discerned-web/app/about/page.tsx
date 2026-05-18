'use client';

import { useState } from 'react';
import HeroBeacon from '@/components/brand/HeroBeacon';
import TopBar from '@/components/chrome/TopBar';
import SignInModal from '@/components/auth/SignInModal';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useBridgeAuth } from '@/hooks/useBridgeAuth';

export default function AboutPage() {
  const { auth, signInPubkey } = useNostrAuth();
  const { extensionPresent } = useBridgeAuth();
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--paper)' }}>
      <TopBar
        auth={auth}
        onSignIn={() => setSignInOpen(true)}
        extensionPresent={extensionPresent}
      />

      <section className="hero">
        <div className="hero-art">
          <HeroBeacon />
        </div>
        <div className="hero-copy">
          <div className="hero-eyebrow">A value-attribution layer for the web</div>
          <h1 className="hero-title">Signal,<br /><em>not noise.</em></h1>
          <p className="hero-lede">
            Discerned is a quiet protocol for thoughtful readers. Clip what matters,
            rate it across <strong>Interest</strong>, <strong>Ethics</strong>, and <strong>Category</strong>,
            and broadcast — or don&apos;t. Your library is yours; the signal is shared.
          </p>
          <div className="hero-cta">
            <button className="btn primary">Get the extension</button>
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 720, margin: '0 auto', padding: '56px 32px 80px', fontFamily: 'var(--serif)', color: 'var(--ink-2)', fontSize: 17, lineHeight: 1.65 }}>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, color: 'var(--ink)', margin: '0 0 16px', letterSpacing: '-0.015em' }}>
          Judgment over reaction.
        </h2>
        <p style={{ margin: '0 0 16px' }}>
          Most platforms reward the loudest voice. Discerned rewards the most honest one.
          Every clip carries a structured assessment — <em>Interest</em>, <em>Ethics</em>, and <em>Category</em> —
          recorded with the same care a librarian gives an accession.
        </p>
        <p style={{ margin: '0 0 16px' }}>
          Your reading is yours. The app stores everything locally first. When you choose to
          cast a clip, it&apos;s signed in your browser and broadcast to relays you trust — never
          ours, because we don&apos;t run any.
        </p>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: '32px 0 10px' }}>
          Sovereignty, not gamification.
        </h3>
        <p style={{ margin: '0 0 16px' }}>
          No likes. No streaks. No engagement loops. The interface slows you down on purpose —
          because considered judgment cannot be rushed.
        </p>
      </section>

      {signInOpen && (
        <SignInModal
          onClose={() => setSignInOpen(false)}
          onSignedIn={(pubkey) => signInPubkey(pubkey)}
        />
      )}
    </div>
  );
}
