// Lightning + PayPal donation block for /feedback.
//
// The Lightning QR is a committed static asset (see scripts/gen-lightning-qr.mjs), not
// generated at runtime — under output:'export' the address is a constant, so a runtime
// QR library would cost bundle weight for nothing.

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  LIGHTNING_ADDRESS, LIGHTNING_URI, LIGHTNING_QR_SRC,
  PAYPAL_BUSINESS_ID, PAYPAL_SDK_SRC, PAYPAL_BUTTON_IMAGE,
} from '@/lib/support';
import { countEvent } from '@/lib/analytics';
import { LL, log } from '@/lib/logger';

// PayPal's donate SDK global. Typed narrowly — we only construct and render a button.
interface PayPalDonation {
  Button: (opts: {
    env: string;
    business: string;
    image: { src: string; title: string; alt: string };
    onComplete?: (params: unknown) => void;
  }) => { render: (selector: string) => void };
}
declare global {
  interface Window { PayPal?: { Donation?: PayPalDonation } }
}

const PAYPAL_CONTAINER_ID = 'paypal-donate-button-container';

export default function DonateSection() {
  const [copied, setCopied] = useState(false);
  const [thanked, setThanked] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paypalRendered = useRef(false);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(LIGHTNING_ADDRESS);
      setCopied(true);
      countEvent('donate-lightning-copy', 'Lightning address copied');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied or unavailable — .donate-address has user-select:all, so a
      // single click still selects the whole address. Nothing to report.
      log(LL.DEBUG, '[donate] clipboard unavailable; falling back to manual selection');
    }
  };

  // Load the PayPal SDK lazily, only for this page. A blocked or offline script must
  // leave the rest of the page working rather than throwing.
  useEffect(() => {
    let cancelled = false;

    const render = () => {
      if (cancelled || paypalRendered.current) return;
      const donation = window.PayPal?.Donation;
      if (!donation) return;
      const host = document.getElementById(PAYPAL_CONTAINER_ID);
      if (!host || host.childElementCount > 0) return; // guard StrictMode double-invoke
      try {
        donation.Button({
          env: 'production',
          business: PAYPAL_BUSINESS_ID,
          image: {
            src: PAYPAL_BUTTON_IMAGE,
            title: 'PayPal - The safer, easier way to pay online!',
            alt: 'Donate with PayPal button',
          },
          onComplete: () => {
            setThanked(true);
            countEvent('donate-paypal-complete', 'PayPal donation completed');
          },
        }).render(`#${PAYPAL_CONTAINER_ID}`);
        paypalRendered.current = true;
      } catch (err) {
        log(LL.WARN, '[donate] PayPal button render failed', err);
      }
    };

    if (window.PayPal?.Donation) { render(); return () => { cancelled = true; }; }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PAYPAL_SDK_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', render);
    if (!existing) {
      script.src = PAYPAL_SDK_SRC;
      script.charset = 'UTF-8';
      script.async = true;
      script.addEventListener('error', () => log(LL.WARN, '[donate] PayPal SDK failed to load'));
      document.head.appendChild(script);
    }
    return () => { cancelled = true; script.removeEventListener('load', render); };
  }, []);

  return (
    <div>
      <div className="donate-method">
        <div className="donate-method-label">
          <span aria-hidden="true">⚡</span> Lightning
        </div>
        {/* Explicit dimensions reserve layout space (no CLS). A plain <img>, not
            next/image — that needs a loader under output:'export' and there is nothing
            to optimise in a 1.7 kB static SVG. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="donate-qr"
          src={LIGHTNING_QR_SRC}
          width={180}
          height={180}
          alt={`QR code for the Lightning address ${LIGHTNING_ADDRESS}`}
        />
        <div className="donate-row">
          <code className="donate-address">{LIGHTNING_ADDRESS}</code>
          <button type="button" className="btn" onClick={copyAddress}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a className="btn" href={LIGHTNING_URI}>Open in wallet</a>
        </div>
        <p className="settings-hint">
          Scan with any Lightning wallet, or copy the address. &ldquo;Open in wallet&rdquo;
          works if you have a Lightning wallet installed.
        </p>
      </div>

      <div className="donate-method">
        <div className="donate-method-label">
          <span aria-hidden="true">💳</span> Card or PayPal
        </div>
        <div id={PAYPAL_CONTAINER_ID} />
        {thanked && (
          <p className="settings-hint" role="status" style={{ color: 'var(--accent-ink)' }}>
            Thank you — that genuinely helps.
          </p>
        )}
        <p className="settings-hint">
          Opens a PayPal window. You don&apos;t need a PayPal account to pay by card.
        </p>
      </div>
    </div>
  );
}
