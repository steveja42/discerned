// Root layout — applies the Editorial design system body class and project metadata.
// All pages share this shell; no navigation chrome is rendered here (TopBar lives per-page).

import type { Metadata } from 'next';
import './globals.css';
import { ClipStoreProvider } from '@/lib/bridge/ClipStoreContext';

export const metadata: Metadata = {
  title: 'Discerned — Signal, not noise.',
  description: 'A value-attribution layer for the web. Clip, rate, broadcast.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="style-editorial">
        <ClipStoreProvider>{children}</ClipStoreProvider>
      </body>
    </html>
  );
}
