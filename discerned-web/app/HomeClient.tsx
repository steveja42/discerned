// Client root for the home page (/). Wires together auth state, the live Cast feed,
// the first-visit popover, and the sign-in modal. Brand clicks dismiss the popover
// and navigate to /about.

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

export default function HomeClient() {
  const router = useRouter();
  const { auth, signInPubkey } = useNostrAuth();
  const { showPopover, dismiss: dismissPopover } = useFirstVisit();
  const { clips, status } = useCastFeed();
  const { extensionPresent } = useBridgeAuth();
  const [signInOpen, setSignInOpen] = useState(false);

  const handleBrandClick = () => {
    dismissPopover();
    router.push('/');
  };

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
      />

      {showPopover && (
        <FirstVisitPopover
          onDismiss={dismissPopover}
          onLearnMore={handleLearnMore}
        />
      )}

      <CastFeed clips={clips} status={status} />

      {signInOpen && (
        <SignInModal
          onClose={() => setSignInOpen(false)}
          onSignedIn={(pubkey) => signInPubkey(pubkey)}
        />
      )}
    </div>
  );
}
