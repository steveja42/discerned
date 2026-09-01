// Sticky application topbar with brand mark, search input, nav links, and auth avatar.
// When brandHasPopover is true, the beacon pulses to draw attention to the first-visit popover.
// The brand always goes home (/discerns — / is only a redirect to it). onBrandClick is an
// optional override for pages that need side effects first (DiscernsClient dismisses the
// first-visit popover); without it the mark is a plain <Link>, so content pages like /about
// and /feedback get working brand navigation for free.
//
// The search box only renders when a page passes onSearchChange. Static content routes
// (/about, /feedback) have nothing to search, and an inert input that
// swallows Ctrl+K reads as broken.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useEffect, useState } from 'react';
import MiniBeacon from '@/components/brand/MiniBeacon';
import StatusDot from '@/components/auth/StatusDot';
import SettingsModal from '@/components/chrome/SettingsModal';
import { getActiveRelays, onRelayModeChange } from '@/lib/constants';
import { GITHUB_REPO_URL } from '@/lib/support';
import { authorDisplayName } from '@/lib/nostr/profiles';
import { useOwnProfile } from '@/hooks/useOwnProfile';
import type { AuthState } from '@/lib/types';

// The feed is home: `/` is a client-side redirect to it (see app/page.tsx), so linking
// straight here avoids a pointless double navigation.
const HOME_HREF = '/discerns';

interface TopBarProps {
  auth: AuthState;
  onSignIn: () => void;
  brandHasPopover?: boolean;
  onBrandClick?: () => void;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (q: string) => void;
  extensionPresent?: boolean;
}

function GitHubIcon() {
  return (
    <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.1-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.93.36.3.68.92.68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export default function TopBar({ auth, onSignIn, brandHasPopover, onBrandClick, searchPlaceholder, searchValue, onSearchChange, extensionPresent }: TopBarProps) {
  const path = usePathname();
  const searchRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Track the active relay count so the Nostr dot tooltip stays current when the
  // relay mode flips (local ↔ production). Initialised from the env-resolved
  // default (SSR-safe and identical on first client render → no hydration drift).
  const [relayCount, setRelayCount] = useState(() => getActiveRelays().length);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  // Prefer a NIP-05 (or kind-0) name over the bare npub in the account chip — this is
  // the user's own identity, not attribution on a cast, so an unverified name is fine.
  const ownProfile = useOwnProfile(auth.pubkey);
  const identityLabel = auth.pubkey ? authorDisplayName(auth.pubkey, ownProfile ?? undefined) : '';

  useEffect(() => onRelayModeChange(() => setRelayCount(getActiveRelays().length)), []);

  // The extension's "Manage relays" link deep-links here with ?settings=1 — open
  // the panel directly rather than dropping the user on the feed to hunt for the
  // gear. Read from window.location (not useSearchParams) to avoid the Suspense
  // boundary a static export would otherwise require; same approach as
  // useNostrAuth's ?signin=1 handling. The param is stripped afterwards so a
  // reload or shared link doesn't reopen the modal.
  //
  // This MUST stay in an effect rather than a useState initialiser: the app is a
  // static export, so the pre-rendered HTML never has the modal open. Opening it
  // during the first render would not match that markup and React would fail
  // hydration on the whole subtree.
  //
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('settings') !== '1') return;
    /* eslint-disable react-hooks/set-state-in-effect -- see the note above: the
       post-hydration setState is what keeps the first render matching the HTML. */
    setSettingsOpen(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    const url = new URL(window.location.href);
    url.searchParams.delete('settings');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isTrigger = isMac ? e.metaKey && e.key === 'k' : e.ctrlKey && e.key === 'k';
      if (!isTrigger) return;
      const el = searchRef.current;
      // No search box on this route — let the browser keep its own Ctrl+K.
      if (!el) return;
      e.preventDefault();
      if (document.activeElement === el) {
        el.select();
      } else {
        el.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isMac]);

  const navLink = (href: string, label: string, title?: string) => (
    <Link href={href} className={`topbar-link ${path === href ? 'topbar-link-active' : ''}`} title={title}>{label}</Link>
  );

  return (
    <>
    <header className="topbar">
      <Link
        href={HOME_HREF}
        className={`brand brand-clickable ${brandHasPopover ? 'brand-pulse' : ''}`}
        aria-label="Discerned — home"
        onClick={onBrandClick}
      >
        <span className="brand-mark" aria-hidden="true">
          <MiniBeacon size={24} />
        </span>
        <span className="brand-name">Discerned</span>
      </Link>

      {onSearchChange ? (
        <div className="search">
          <SearchIcon />
          <input
            ref={searchRef}
            placeholder={searchPlaceholder ?? 'Search clips, casters, sources…'}
            value={searchValue ?? ''}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          <kbd>{isMac ? '⌘K' : 'Ctrl+K'}</kbd>
        </div>
      ) : (
        // Keep the middle grid/flex cell occupied so the nav rail stays put.
        <div className="search-spacer" aria-hidden="true" />
      )}

      <div className="topbar-right">
        {navLink('/discerns', 'Discerns', 'Clips that have been broadcast on Nostr')}
        {extensionPresent && navLink('/clips', 'My Clips', 'Clips stored only on this device')}
        {navLink('/about', 'About')}
        {/* An icon rather than a 4th nav link — the right rail already carries three
            links, two icon buttons, and two status dots. */}
        <Link href="/feedback" className="icon-btn" title="Feedback & support">
          <HeartIcon />
        </Link>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="icon-btn"
          title="Repository on GitHub"
        >
          <GitHubIcon />
        </a>
        <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </button>
        <StatusDot
          variant="nostr"
          connected={auth.status !== 'guest'}
          tooltip={
            auth.status === 'guest'
              ? 'Sign in with Nostr'
              : `Nostr · ${
                  auth.source === 'nip07' ? 'via NIP-07' :
                  auth.source === 'bridge' ? 'via extension' :
                  'read-only'
                } · ${identityLabel} · ${relayCount} relay${relayCount === 1 ? '' : 's'}`
          }
          onClick={onSignIn}
          label={auth.status === 'guest' ? 'Sign in with Nostr' : `Nostr connected · ${identityLabel}`}
        />
        <StatusDot
          connected={!!extensionPresent}
          tooltip={extensionPresent ? 'Extension connected' : 'Extension not detected'}
          label={extensionPresent ? 'Extension connected' : 'Extension not detected'}
        />
      </div>
    </header>
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
