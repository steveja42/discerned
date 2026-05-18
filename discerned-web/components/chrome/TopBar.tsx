// Sticky application topbar with brand mark, search input, nav links, and auth avatar.
// When brandHasPopover is true, the beacon pulses to draw attention to the first-visit popover.
// onBrandClick is wired by HomeClient to dismiss the popover and navigate to /about.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useEffect } from 'react';
import MiniBeacon from '@/components/brand/MiniBeacon';
import StatusDot from '@/components/auth/StatusDot';
import type { AuthState } from '@/lib/types';

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
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isTrigger = isMac ? e.metaKey && e.key === 'k' : e.ctrlKey && e.key === 'k';
      if (!isTrigger) return;
      e.preventDefault();
      const el = searchRef.current;
      if (!el) return;
      if (document.activeElement === el) {
        el.select();
      } else {
        el.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isMac]);

  const navLink = (href: string, label: string) => (
    <Link href={href} className={`topbar-link ${path === href ? 'topbar-link-active' : ''}`}>{label}</Link>
  );

  return (
    <header className="topbar">
      <div
        className={`brand brand-clickable ${brandHasPopover ? 'brand-pulse' : ''}`}
        onClick={onBrandClick}
        role={onBrandClick ? 'button' : undefined}
        tabIndex={onBrandClick ? 0 : undefined}
        onKeyDown={onBrandClick ? (e) => { if (e.key === 'Enter') onBrandClick(); } : undefined}
      >
        <span className="brand-mark" aria-hidden="true">
          <MiniBeacon size={24} />
        </span>
        <span className="brand-name">Discerned</span>
      </div>

      <div className="search">
        <SearchIcon />
        <input
          ref={searchRef}
          placeholder={searchPlaceholder ?? 'Search clips, casters, sources…'}
          value={searchValue ?? ''}
          onChange={(e) => onSearchChange?.(e.target.value)}
        />
        <kbd>{isMac ? '⌘K' : 'Ctrl+K'}</kbd>
      </div>

      <div className="topbar-right">
        {navLink('/', 'Discernments')}
        {extensionPresent && navLink('/library', 'My Library')}
        {navLink('/about', 'About')}
        <a
          href="https://github.com/discerned-online"
          target="_blank"
          rel="noopener noreferrer"
          className="icon-btn"
          title="Repository on GitHub"
        >
          <GitHubIcon />
        </a>
        <button className="icon-btn" title="Settings">
          <SettingsIcon />
        </button>
        <StatusDot
          connected={auth.status !== 'guest'}
          tooltip={
            auth.status === 'guest'
              ? 'Sign in with Nostr'
              : `Nostr · ${
                  auth.source === 'nip07' ? 'via NIP-07' :
                  auth.source === 'bridge' ? 'via bridge' :
                  'read-only'
                } · ${auth.pubkey?.slice(0, 8)}…`
          }
          onClick={onSignIn}
          label={auth.status === 'guest' ? 'Sign in with Nostr' : `Nostr connected · ${auth.pubkey?.slice(0, 8)}`}
        />
        <StatusDot
          connected={!!extensionPresent}
          tooltip={extensionPresent ? 'Extension connected' : 'Extension not detected'}
          label={extensionPresent ? 'Extension connected' : 'Extension not detected'}
        />
      </div>
    </header>
  );
}
