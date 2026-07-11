// Root layout — applies the Studio design system body class and project metadata.
// All pages share this shell; no navigation chrome is rendered here (TopBar lives per-page).

import type { Metadata } from 'next';
import './globals.css';
import { ClipStoreProvider } from '@/lib/bridge/ClipStoreContext';
import { NostrAuthProvider } from '@/hooks/useNostrAuth';
import PendingSignModal from '@/components/auth/PendingSignModal';
import GoatCounter from '@/components/analytics/GoatCounter';

export const metadata: Metadata = {
  title: 'Discerned — Signal, not noise.',
  description: 'A value-attribution layer for the web. Clip, rate, broadcast.',
};


export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="style-studio">
<NostrAuthProvider>
          <ClipStoreProvider>{children}</ClipStoreProvider>
          <PendingSignModal />
        </NostrAuthProvider>
        <GoatCounter />
      </body>
    </html>
  );
}
