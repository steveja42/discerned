'use client';

import { useState } from 'react';
import Link from 'next/link';
import HeroBeacon from '@/components/brand/HeroBeacon';
import TopBar from '@/components/chrome/TopBar';
import SignInModal from '@/components/auth/SignInModal';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useBridgeAuth } from '@/hooks/useBridgeAuth';
import { PITCH } from '@/lib/marketing-copy';
import { WEB_STORE_URL } from '@/lib/constants';
import { countEvent } from '@/lib/analytics';

export default function AboutPage() {
  const { auth, signInPubkey, setNip07Connected } = useNostrAuth();
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
          <div className="hero-eyebrow">{PITCH.eyebrow}</div>
          <h1 className="hero-title">{PITCH.title}<br /><em>{PITCH.titleEm}</em></h1>
          <p className="hero-lede">
            {PITCH.lede()}
          </p>

          <div className="hero-cta">
            <a
              href={WEB_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn primary"
              style={{ textDecoration: 'none' }}
              onClick={() => countEvent('install-extension', 'Chrome Web Store install')}
            >
              Get the extension
            </a>
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 720, margin: '0 auto', padding: '28px 32px 80px', fontFamily: 'var(--serif)', color: 'var(--ink-2)', fontSize: 17, lineHeight: 1.65 }}>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, color: 'var(--ink)', margin: '0 0 16px', letterSpacing: '-0.015em' }}>
          Signal, filtered
        </h2>
        <p style={{ margin: '0 0 16px' }}>
          A <strong>Discern</strong> is a clip someone cast from the extension. It can carry a structured
          assessment — a <strong>Signal</strong> rating, <strong>Qualifier</strong> tags, and a <strong>Category</strong> —
          or just the clip itself.
        </p>
        <p style={{ margin: '0 0 16px' }}>
          Filter the feed down to what you actually want: a specific Signal level or Qualifiers,
          a Category, or the people you follow. Narrow it to what&apos;s unread, or search Discerns.
          No algorithm deciding what you see — you decide.
        </p>

        <p style={{ margin: '32px 0 0', paddingTop: 24, borderTop: '1px solid var(--rule)', fontSize: 15 }}>
          Discerned is a small, independent project. If something is broken or missing,{' '}
          <Link href="/feedback" style={{ color: 'var(--accent-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
            tell us — or help keep it going →
          </Link>
        </p>
      </section>

      {signInOpen && (
        <SignInModal
          onClose={() => setSignInOpen(false)}
          onSignedIn={(pubkey) => signInPubkey(pubkey)}
          onNip07SignedIn={(pubkey) => setNip07Connected(pubkey)}
        />
      )}
    </div>
  );
}
