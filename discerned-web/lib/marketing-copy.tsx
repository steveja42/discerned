// Shared marketing copy for the first-visit popover and the About page hero.
// Edit here to change the pitch in both places at once.

import Link from 'next/link';

export const PITCH = {
  eyebrow: 'A value-attribution layer for the web',
  title: 'Signal,',
  titleEm: 'not noise',
  lede: () => (
    <>
      Discerned is powered by a{' '}
      <Link href="/get-extension">browser extension</Link>{' '}
      that lets you clip and rate anything on the web. See what your friends and follows love and hate.
    </>
  ),
};
