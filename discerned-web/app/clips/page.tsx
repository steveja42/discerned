'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/chrome/TopBar';
import Library from '@/components/clips/Library';
import SignInModal from '@/components/auth/SignInModal';
import { useNostrAuth } from '@/hooks/useNostrAuth';
import { useBridgeAuth } from '@/hooks/useBridgeAuth';

function LibraryWithClipId({ searchQuery }: { searchQuery: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialClipId = searchParams.get('clip') ?? undefined;

  // Remove ?clip= from the URL immediately after reading it so the address bar
  // stays clean and back-button history isn't polluted.
  useEffect(() => {
    if (initialClipId) {
      router.replace('/library', { scroll: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Library initialClipId={initialClipId} searchQuery={searchQuery} />;
}

export default function LibraryPage() {
  const router = useRouter();
  const { auth, signInPubkey } = useNostrAuth();
  const { extensionPresent } = useBridgeAuth();
  const [signInOpen, setSignInOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div>
      <TopBar
        auth={auth}
        onSignIn={() => setSignInOpen(true)}
        onBrandClick={() => router.push('/')}
        searchPlaceholder="Search your clips…"
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        extensionPresent={extensionPresent}
      />
      <Suspense fallback={<Library />}>
        <LibraryWithClipId searchQuery={searchQuery} />
      </Suspense>
      {signInOpen && (
        <SignInModal
          onClose={() => setSignInOpen(false)}
          onSignedIn={(pubkey) => signInPubkey(pubkey)}
        />
      )}
    </div>
  );
}
