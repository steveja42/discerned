'use client';

// Feedback + support page. Two jobs: file a bug/idea (→ Netlify function → GitHub issue)
// and take a donation (Lightning or PayPal). The extension deep-links here from its
// overlay Settings drawer with ?target=extension&v=<manifest version>.

import { useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/chrome/TopBar';
import SignInModal from '@/components/auth/SignInModal';
import FeedbackForm from '@/components/feedback/FeedbackForm';
import DonateSection from '@/components/feedback/DonateSection';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useBridgeAuth } from '@/hooks/useBridgeAuth';
import { GITHUB_REPO_URL } from '@/lib/support';

const linkStyle: React.CSSProperties = {
  color: 'var(--accent-ink)',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
};

const sectionHeading: React.CSSProperties = {
  fontFamily: 'var(--serif)',
  fontSize: 24,
  fontWeight: 500,
  color: 'var(--ink)',
  margin: '0 0 8px',
  letterSpacing: '-0.015em',
};

const sectionLede: React.CSSProperties = {
  fontFamily: 'var(--serif)',
  fontSize: 15,
  color: 'var(--ink-2)',
  lineHeight: 1.6,
  margin: '0 0 24px',
};

export default function FeedbackPage() {
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

      <section style={{ maxWidth: 720, margin: '0 auto', padding: '56px 32px 32px' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 14 }}>
          Feedback &amp; support
        </div>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 40, fontWeight: 500, color: 'var(--ink)', margin: '0 0 16px', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          Tell us what&apos;s wrong<br />
          <em style={{ fontStyle: 'italic', color: 'var(--accent-ink)' }}>or what&apos;s missing.</em>
        </h1>
        <p style={{ fontFamily: 'var(--serif)', fontSize: 17, color: 'var(--ink-2)', lineHeight: 1.65, margin: 0 }}>
          Discerned is a small project, and the fastest way it improves is people saying what
          broke or what they wish it did. Reports become public issues on{' '}
          <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>GitHub</a>,
          so you can follow what happens next.
        </p>
      </section>

      <section style={{ maxWidth: 720, margin: '0 auto', padding: '8px 32px 48px' }}>
        <FeedbackForm />
      </section>

      <section style={{ maxWidth: 720, margin: '0 auto', padding: '24px 32px 80px', borderTop: '1px solid var(--rule)' }}>
        <h2 style={{ ...sectionHeading, marginTop: 32 }}>Support the project</h2>
        <p style={sectionLede}>
          Discerned is free, has no ads, and doesn&apos;t sell anything — your clips stay on your
          machine. If it&apos;s useful to you, a donation keeps it going. Entirely optional, and
          nothing in the app changes either way.
        </p>
        <DonateSection />

        <p style={{ fontFamily: 'var(--serif)', fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.6, margin: '8px 0 0' }}>
          Not sure what Discerned is? Read <Link href="/about" style={linkStyle}>what it is and why it works this way →</Link>
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
