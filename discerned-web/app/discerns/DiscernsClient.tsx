// Client root for the Discerns feed page (/discerns). Wires together auth state,
// the live Cast feed, the first-visit popover, and the sign-in modal. Brand clicks
// dismiss the popover and navigate to /about.

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import TopBar from '@/components/chrome/TopBar';
import CastFeed from '@/components/feed/CastFeed';
import SignInModal from '@/components/auth/SignInModal';
import FirstVisitPopover from '@/components/popover/FirstVisitPopover';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useFirstVisit } from '@/hooks/useFirstVisit';
import { useCastFeed } from '@/hooks/useCastFeed';
import { useBridgeAuth } from '@/hooks/useBridgeAuth';
import { useFollowList } from '@/hooks/useFollowList';
import { useAuthorProfiles } from '@/hooks/useAuthorProfiles';
import { useReadCasts } from '@/hooks/useReadCasts';

export default function DiscernsClient() {
  const router = useRouter();
  const { auth, signInPubkey, setNip07Connected, autoSigninError, clearAutoSigninError } = useNostrAuth();
  const { showPopover, dismiss: dismissPopover } = useFirstVisit();
  const { clips } = useCastFeed();
  const { extensionPresent } = useBridgeAuth();
  const follows = useFollowList(auth.pubkey);
  const authors = useAuthorProfiles(clips);
  const { read, markRead } = useReadCasts();
  const [signInOpen, setSignInOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // The brand mark is a <Link> to /discerns in TopBar, so this only handles the
  // side effect — navigation is the link's job.
  const handleBrandClick = () => dismissPopover();

  const handleLearnMore = () => {
    dismissPopover();
    router.push('/about');
  };

  return (
    <div style={{ position: 'relative' }}>
      <TopBar
        auth={auth}
        onSignIn={() => setSignInOpen(true)}
        brandHasPopover={showPopover}
        onBrandClick={handleBrandClick}
        extensionPresent={extensionPresent}
        searchPlaceholder="Search Discerns…"
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {showPopover && (
        <FirstVisitPopover
          onDismiss={dismissPopover}
          onLearnMore={handleLearnMore}
        />
      )}

      {autoSigninError && auth.status !== 'connected' && (
        <div className="signin-error-banner" role="alert">
          <span>{autoSigninError}</span>
          <button className="btn" onClick={() => { clearAutoSigninError(); setSignInOpen(true); }}>Try again</button>
          <button className="btn" onClick={clearAutoSigninError} aria-label="Dismiss">✕</button>
        </div>
      )}

      <CastFeed
        clips={clips}
        searchQuery={searchQuery}
        follows={follows}
        authors={authors}
        isSignedIn={auth.status !== 'guest'}
        read={read}
        markRead={markRead}
        extensionPresent={extensionPresent}
      />

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
