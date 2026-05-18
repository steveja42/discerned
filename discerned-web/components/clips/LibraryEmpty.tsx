// Empty state shown in /library when no extension bridge is detected after 2 seconds.
// Prompts the user to install the Discerned Chrome extension to populate their Library.

import Link from 'next/link';

export default function LibraryEmpty() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '80px 32px', textAlign: 'center', flex: 1,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: '50%',
        border: '1px solid var(--rule)',
        display: 'grid', placeItems: 'center',
        marginBottom: 24, color: 'var(--ink-4)',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)', margin: '0 0 12px', letterSpacing: '-0.015em' }}>
        Your Library lives in the extension.
      </h2>
      <p style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 400, margin: '0 0 28px' }}>
        Install the Discerned extension to clip and store articles privately.
        Your clips appear here automatically when you open this page from the extension.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <a
          href="https://github.com/discerned-online"
          target="_blank"
          rel="noopener noreferrer"
          className="btn primary"
        >
          Get the Extension
        </a>
        <Link href="/about" className="btn ghost">
          Learn more about sovereignty →
        </Link>
      </div>
    </div>
  );
}
