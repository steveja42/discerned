// Root route (/) — client-side redirect to the Discerns feed at /discerns.
// The app is a static export (output: 'export'), so next.config redirects can't
// run at runtime; this replace() works identically in dev, tests, and prod.
// Query string and hash are preserved so the extension's /?signin=1 auto-sign-in
// flow keeps working.

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/discerns' + window.location.search + window.location.hash);
  }, [router]);

  return null;
}
