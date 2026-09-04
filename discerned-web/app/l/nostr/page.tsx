// Track A landing page — the Nostr-native audience.
//
// Campaign destination, linked only from Track A channels (Nostr posts, Nostr app
// directories, curation/reading communities). Leads on sovereignty and signing;
// the capture quality is the second beat, because the Nostr audience has seen plenty
// of "publish to Nostr" tools and the layout-preserving capture is what's actually
// unusual. See marketing/STRATEGY.md §3 and marketing/copy/claims.md.
//
// The install CTA fires its own event path so page-level conversion is visible;
// summing the install-extension* paths gives the total. Pageviews are counted
// globally by components/analytics/GoatCounter.tsx — nothing to wire per page.

'use client';

import { useState } from 'react';
import Link from 'next/link';
import HeroBeacon from '@/components/brand/HeroBeacon';
import TopBar from '@/components/chrome/TopBar';
import SignInModal from '@/components/auth/SignInModal';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useBridgeAuth } from '@/hooks/useBridgeAuth';
import { WEB_STORE_URL } from '@/lib/constants';
import { countEvent } from '@/lib/analytics';

const h2 = {
  fontFamily: 'var(--serif)',
  fontSize: 22,
  fontWeight: 500,
  color: 'var(--ink)',
  margin: '36px 0 12px',
  letterSpacing: '-0.015em',
} as const;

const p = { margin: '0 0 16px' } as const;

export default function NostrLandingPage() {
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
          <div className="hero-eyebrow">Clip the web. Sign what&apos;s worth it.</div>
          <h1 className="hero-title">Your judgement,<br /><em>under your own key</em></h1>
          <p className="hero-lede">
            Clip anything on the web, rate it yourself, and publish that evaluation to Nostr as a
            signed note. Nothing is scored automatically. Private clips stay in your browser
            unless you cast them.
          </p>

          <div className="hero-cta">
            <a
              href={WEB_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn primary"
              style={{ textDecoration: 'none' }}
              onClick={() => countEvent('install-extension-nostr', 'Install from /l/nostr')}
            >
              Get the extension
            </a>
            <Link href="/discerns" className="btn" style={{ textDecoration: 'none' }}>
              See the feed
            </Link>
          </div>
        </div>
      </section>

      <section
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: '28px 32px 80px',
          fontFamily: 'var(--serif)',
          color: 'var(--ink-2)',
          fontSize: 17,
          lineHeight: 1.65,
        }}
      >
        <h2 style={{ ...h2, margin: '0 0 16px', fontSize: 26 }}>
          Clip and cast, kept distinct
        </h2>
        <p style={p}>
          A <strong>clip</strong> is private — stored locally, in your own browser, and it goes
          nowhere else. A <strong>cast</strong> is public, published to relays and signed with
          your own key. You choose which at the moment you capture: keep it local, cast it, or
          both.
        </p>
        <p style={{ ...p, fontSize: 15, color: 'var(--ink-3)' }}>
          Clips are local and private, but not encrypted — that&apos;s designed and not yet built.
        </p>

        <h2 style={h2}>What actually gets published</h2>
        <p style={p}>
          Each cast is a kind-1 note, plus a NIP-23 long-form note (kind 30023) carrying the
          article body when there is one, referenced by an <code>a</code> tag. The evaluation
          travels as NIP-32 labels under the <code>online.discerned.*</code> namespaces, so other
          clients can read the signal level, qualifiers and category rather than parsing prose.
        </p>
        <p style={p}>
          Sign in with a NIP-07 browser extension, a NIP-46 bunker, or a local key encrypted with
          a PIN under NIP-49 — or skip signing in and just keep clips. Your relay set is yours to
          edit, and is discovered from your NIP-65 list when you sign in.
        </p>

        <h2 style={h2}>The capture is the unusual part</h2>
        <p style={p}>
          Most clippers flatten a page into plain text. Discerned keeps the structure, with
          dedicated handling for sixteen sites that ordinarily defeat clippers — including
          primal.net and Bluesky, where a thread should still read as a thread. Div-soup clients
          capture as readable posts rather than a wall of stripped text.
        </p>

        <h2 style={h2}>No algorithm on the feed</h2>
        <p style={p}>
          The public feed at{' '}
          <Link href="/discerns" style={{ color: 'var(--accent-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
            discerned.online/discerns
          </Link>{' '}
          shows what people cast. Filter it by signal level, qualifiers, category, or the people
          you follow; narrow it to unread, or search it. There is no ranking, no curation and no
          reputation model — you set the filters, and nothing decides for you.
        </p>

        <h2 style={h2}>What&apos;s planned</h2>
        <p style={p}>
          <strong>Tipping.</strong> Send a small amount of Bitcoin straight to someone whose
          discern you valued — so praising good work can mean more than a click.
        </p>
        <p style={p}>
          <strong>Voting.</strong> Agree or disagree with someone else&apos;s assessment — turning
          one reader&apos;s rating into a shared sense of whose judgement is worth trusting.
        </p>

        <div style={{ marginTop: 36 }}>
          <a
            href={WEB_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn primary"
            style={{ textDecoration: 'none' }}
            onClick={() => countEvent('install-extension-nostr', 'Install from /l/nostr')}
          >
            Get the extension
          </a>
        </div>

        <p style={{ margin: '32px 0 0', paddingTop: 24, borderTop: '1px solid var(--rule)', fontSize: 15 }}>
          Chrome and Chromium browsers; Firefox, Android and iOS are planned. Free, open source,
          no ads.{' '}
          <Link href="/about" style={{ color: 'var(--accent-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
            More about the project →
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
