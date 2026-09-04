// Track B landing page — the web-clipper / PKM audience.
//
// Campaign destination, linked only from Track B channels (Chrome Web Store,
// AlternativeTo, PKM communities, subreddits, Show HN). Leads on layout-preserving
// capture; Nostr appears below the fold as an optional destination, never in the
// opening. See marketing/STRATEGY.md §3 and marketing/copy/claims.md for the claim
// IDs behind each statement here.
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

export default function ClipperLandingPage() {
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
          <div className="hero-eyebrow">A web clipper that keeps the layout</div>
          <h1 className="hero-title">Clip the page,<br /><em>not a flat copy of it</em></h1>
          <p className="hero-lede">
            Most clippers flatten a page into plain text and lose what made it worth saving.
            Discerned keeps the structure — threaded replies, code blocks, bylines and images
            land roughly where they were.
          </p>

          <div className="hero-cta">
            <a
              href={WEB_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn primary"
              style={{ textDecoration: 'none' }}
              onClick={() => countEvent('install-extension-clipper', 'Install from /l/clipper')}
            >
              Get the extension
            </a>
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
          The sites that usually break
        </h2>
        <p style={p}>
          A Reddit thread should stay a thread. A Stack Overflow answer should keep its code
          blocks. A forum post should keep its attribution. Discerned carries dedicated handling
          for sixteen sites that ordinarily defeat clippers — Reddit, YouTube, Hacker News,
          Stack&nbsp;Overflow, Bluesky, primal.net, Instagram, TikTok, Facebook, Goodreads,
          Zillow, Etsy, Yelp, Twitter/X, and forums running phpBB or SMF — plus generic
          structure detection for everything else.
        </p>
        <p style={p}>
          Ads, navigation and page clutter are dropped. Around sixty end-to-end tests, many with
          pixel baselines, guard this against regressions, because sites redesign without warning
          and a quietly degraded capture is the easiest kind to miss.
        </p>

        <h2 style={h2}>Four ways to capture</h2>
        <p style={p}>
          Save a text selection, a whole article, an entire page, or just a bookmark — one click
          from the toolbar icon, the right-click menu, or a keyboard shortcut. Selections keep
          their surrounding context; articles pull the piece out of the page furniture.
        </p>

        <h2 style={h2}>Rate it, or don&apos;t</h2>
        <p style={p}>
          You can rate what you clipped on a five-level signal scale — Toxic, Noise, Ordinary,
          Worthwhile, Masterpiece — tag it by tone, utility or longevity, file it under a
          category, and add a note. All of that is optional. An unrated clip is perfectly valid,
          and plenty of clipping happens without any evaluation at all.
        </p>
        <p style={p}>
          Nothing is scored automatically. The judgement is yours.
        </p>

        <h2 style={h2}>Your library, on your machine</h2>
        <p style={p}>
          Clips are stored locally in your own browser. No account is required to start, and
          there are no analytics in the extension at all. Export the whole library as JSON
          whenever you want, or import what you already have — including Evernote exports.
        </p>
        <p style={{ ...p, fontSize: 15, color: 'var(--ink-3)' }}>
          Clips are local and private, but not encrypted — that&apos;s designed and not yet built.
        </p>

        <h2 style={h2}>Optional: publish what you rated</h2>
        <p style={p}>
          If you want to share a clip and your rating, you can publish it to Nostr — an open
          protocol where the post is signed by you and no company owns the feed. You choose at
          the moment you capture: keep it local, publish it, or both. A clip stays private unless
          you cast it.
        </p>
        <p style={p}>
          Most people never touch this. It&apos;s a clipper first.
        </p>

        <div style={{ marginTop: 36 }}>
          <a
            href={WEB_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn primary"
            style={{ textDecoration: 'none' }}
            onClick={() => countEvent('install-extension-clipper', 'Install from /l/clipper')}
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
