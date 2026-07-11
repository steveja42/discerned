'use client';

// GoatCounter loader + SPA pageview tracker. The script and its data endpoint are both
// same-origin (Netlify reverse-proxies /api/stats/* → discernedweb.goatcounter.com), so
// hostname-based tracker blockers can't drop them. Active only on the production host;
// a no-op in dev and on Netlify deploy previews. See discerned-web/CLAUDE.md → Analytics.

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { GOATCOUNTER_ENDPOINT, GOATCOUNTER_SCRIPT, isAnalyticsHost, countPageview } from '@/lib/analytics';

export default function GoatCounter() {
  const pathname = usePathname();
  // Resolve the host gate after mount so we render null on the server AND the first
  // client render (isAnalyticsHost reads window) — no hydration mismatch. This is the
  // intended "detect client host post-hydration" pattern; the one-shot setState is
  // deliberate (a lazy initializer would run during SSR and mismatch on hydration).
  const [enabled, setEnabled] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see note above
  useEffect(() => setEnabled(isAnalyticsHost()), []);

  // count.js auto-counts the initial hard load; skip the first pathname the effect sees
  // so we don't double-count it, then count every subsequent App Router soft navigation.
  // A ref (not state) keeps this a plain read/write — no extra render, no state-in-effect.
  const countedInitial = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (!countedInitial.current) {
      countedInitial.current = true;
      return;
    }
    countPageview(pathname);
  }, [pathname, enabled]);

  if (!enabled) return null;
  return (
    <Script
      src={GOATCOUNTER_SCRIPT}
      data-goatcounter={GOATCOUNTER_ENDPOINT}
      strategy="afterInteractive"
    />
  );
}
