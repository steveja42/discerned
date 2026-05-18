// Custom 404 page matching the Editorial design system.

import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--paper)', gap: 16 }}>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>404</p>
      <h1 style={{ fontFamily: 'var(--serif)', fontSize: 32, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>Page not found.</h1>
      <Link href="/" className="btn" style={{ textDecoration: 'none' }}>← Back to Discernments</Link>
    </div>
  );
}
