// Bug report / feature request form. POSTs to the Netlify function (the only server-side
// code in this static-export app), which files a GitHub issue.
//
// See discerned-web/CLAUDE.md → Feedback function.

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  FEEDBACK_TYPES, FEEDBACK_TARGETS, MESSAGE_MIN, MESSAGE_MAX, CONTACT_MAX, EXT_VERSION_RE,
  type FeedbackType, type FeedbackTarget,
} from '@/lib/feedback-format';
import {
  submitFeedback, GITHUB_ISSUES_URL, TURNSTILE_SITE_KEY, TURNSTILE_SCRIPT_SRC,
} from '@/lib/support';
import { countEvent } from '@/lib/analytics';
import { LL, log } from '@/lib/logger';

type Status = 'idle' | 'sending' | 'sent' | 'error';

const TYPE_LABEL: Record<FeedbackType, string> = {
  bug: 'Something is broken',
  idea: 'I have an idea',
  other: 'Something else',
};

const TARGET_LABEL: Record<FeedbackTarget, string> = {
  extension: 'Browser extension',
  web: 'This website',
  both: 'Both',
};

// Turnstile's global, injected by its script. Typed narrowly — we only render and reset.
interface TurnstileApi {
  render: (el: HTMLElement, opts: {
    sitekey: string;
    callback: (token: string) => void;
    'error-callback'?: () => void;
    'expired-callback'?: () => void;
  }) => string;
  reset: (widgetId?: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

/**
 * Deep-link params pushed by the extension (?target=extension&type=bug&v=0.2.0).
 *
 * Read from window.location.search rather than useSearchParams: the latter forces a
 * Suspense boundary under output:'export' (same reason as TopBar's ?settings=1 handling).
 * Guarded for the prerender pass, where `window` doesn't exist.
 *
 * Unlike TopBar we deliberately do NOT strip the params afterwards — there they drive a
 * one-shot modal, here they are form state, and stripping would lose the prefill on reload.
 */
function readParams(): { type?: FeedbackType; target?: FeedbackTarget; version?: string } {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);
  const t = p.get('target');
  const k = p.get('type');
  const v = p.get('v');
  return {
    type: k && (FEEDBACK_TYPES as readonly string[]).includes(k) ? (k as FeedbackType) : undefined,
    target: t && (FEEDBACK_TARGETS as readonly string[]).includes(t) ? (t as FeedbackTarget) : undefined,
    version: v && EXT_VERSION_RE.test(v) ? v : undefined,
  };
}

export default function FeedbackForm() {
  // Lazy initialisers rather than a mount effect: no cascading render, and no frame of
  // the wrong chip highlighted before the deep-link value lands.
  const [type, setType] = useState<FeedbackType>(() => readParams().type ?? 'idea');
  const [target, setTarget] = useState<FeedbackTarget>(() => readParams().target ?? 'web');
  const [extVersion] = useState(() => readParams().version ?? '');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [website, setWebsite] = useState(''); // honeypot

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [issueUrl, setIssueUrl] = useState<string | undefined>();
  const [issueNumber, setIssueNumber] = useState<number | undefined>();

  const turnstileToken = useRef('');
  const turnstileWidget = useRef<string | null>(null);
  const turnstileBox = useRef<HTMLDivElement>(null);

  // Load Turnstile lazily — only this page needs it, and a blocked/offline script must
  // degrade rather than throw (the function still rejects a tokenless submit, so a user
  // who can't load it gets a clear error rather than a silently broken button).
  useEffect(() => {
    let cancelled = false;

    const render = () => {
      if (cancelled || !turnstileBox.current || !window.turnstile) return;
      if (turnstileWidget.current !== null) return; // guard double-render in StrictMode
      try {
        turnstileWidget.current = window.turnstile.render(turnstileBox.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token) => { turnstileToken.current = token; },
          'error-callback': () => { turnstileToken.current = ''; },
          // Tokens expire after ~5 minutes; drop it so a stale one is never submitted.
          'expired-callback': () => { turnstileToken.current = ''; },
        });
      } catch (err) {
        log(LL.WARN, '[feedback] turnstile render failed', err);
      }
    };

    if (window.turnstile) { render(); return () => { cancelled = true; }; }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', render);
    if (!existing) {
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('error', () => log(LL.WARN, '[feedback] turnstile script failed to load'));
      document.head.appendChild(script);
    }
    return () => { cancelled = true; script.removeEventListener('load', render); };
  }, []);

  const canSubmit = message.trim().length >= MESSAGE_MIN;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || status === 'sending') return;

    setStatus('sending');
    setError(null);

    const result = await submitFeedback({
      type, target, message, contact, website,
      turnstileToken: turnstileToken.current,
      extVersion: extVersion || undefined,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });

    if (result.ok) {
      setIssueUrl(result.issueUrl);
      setIssueNumber(result.issueNumber);
      setStatus('sent');
      // Count successes, not clicks.
      countEvent('feedback-submit', 'Feedback submitted');
      return;
    }

    // A Turnstile token is single-use and expires. Without this reset the retry submits a
    // stale token and fails again for a reason the user can't see — the most common
    // Turnstile integration bug.
    turnstileToken.current = '';
    if (window.turnstile && turnstileWidget.current !== null) {
      try { window.turnstile.reset(turnstileWidget.current); } catch { /* widget already gone */ }
    }
    setError(result.error);
    setStatus('error');
  };

  if (status === 'sent') {
    return (
      <div className="feedback-success">
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600, color: 'var(--ink)', margin: '0 0 8px' }}>
          Thanks — that&apos;s filed.
        </h3>
        <p style={{ fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, margin: 0 }}>
          {issueUrl ? (
            <>
              It&apos;s tracked as{' '}
              <a href={issueUrl} target="_blank" rel="noopener noreferrer"
                 style={{ color: 'var(--accent-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                issue #{issueNumber}
              </a>
              . You can follow along there.
            </>
          ) : (
            <>Your feedback reached us. Thank you for taking the time.</>
          )}
        </p>
      </div>
    );
  }

  const sending = status === 'sending';

  return (
    <form className="feedback-form" onSubmit={onSubmit} noValidate>
      {/* One `disabled` on the fieldset locks every control while sending. */}
      <fieldset className="feedback-fieldset" disabled={sending}>
        <div className="feedback-form" style={{ gap: 24 }}>

          <div className="settings-section" style={{ margin: 0 }}>
            <div className="settings-section-label" id="feedback-kind-label">What kind of feedback?</div>
            <div className="feedback-chips" role="radiogroup" aria-labelledby="feedback-kind-label">
              {FEEDBACK_TYPES.map((t) => (
                <label key={t} className="feedback-chip">
                  <input type="radio" name="feedback-type" value={t}
                         checked={type === t} onChange={() => setType(t)} />
                  {TYPE_LABEL[t]}
                </label>
              ))}
            </div>
          </div>

          <div className="settings-section" style={{ margin: 0 }}>
            <div className="settings-section-label" id="feedback-area-label">What is it about?</div>
            <div className="feedback-chips" role="radiogroup" aria-labelledby="feedback-area-label">
              {FEEDBACK_TARGETS.map((t) => (
                <label key={t} className="feedback-chip">
                  <input type="radio" name="feedback-target" value={t}
                         checked={target === t} onChange={() => setTarget(t)} />
                  {TARGET_LABEL[t]}
                </label>
              ))}
            </div>
          </div>

          <div className="settings-section" style={{ margin: 0 }}>
            <label className="settings-section-label" htmlFor="feedback-message">
              {type === 'bug' ? 'What happened?' : 'Tell us more'}
            </label>
            <textarea
              id="feedback-message"
              className="note-textarea"
              style={{ minHeight: 150 }}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={MESSAGE_MAX}
              required
              placeholder={
                type === 'bug'
                  ? 'What you were doing, what you expected, and what happened instead. A link to the page you were clipping helps a lot.'
                  : 'What would you like to see? The more concrete, the better.'
              }
            />
            <p className="settings-hint">
              {extVersion
                ? `Your browser version and extension version (${extVersion}) are included automatically.`
                : 'Your browser version is included automatically.'}
            </p>
          </div>

          <div className="settings-section" style={{ margin: 0 }}>
            <label className="settings-section-label" htmlFor="feedback-contact">
              How to reach you <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
            </label>
            <input
              id="feedback-contact"
              className="feedback-input"
              type="email"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={CONTACT_MAX}
              autoComplete="email"
              placeholder="you@example.com"
            />
            <p className="settings-hint">
              Only if you want a reply. This will be visible in a public GitHub issue.
            </p>
          </div>

          {/* Honeypot — offscreen, unreachable by tab, never autofilled. A human always
              leaves it empty; the function treats any value as a bot. */}
          <div className="feedback-honeypot" aria-hidden="true">
            <label htmlFor="feedback-website">Website</label>
            <input id="feedback-website" type="text" name="website" tabIndex={-1}
                   autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>

          <div ref={turnstileBox} data-testid="turnstile" />

          <div className="feedback-actions">
            <button type="submit" className="btn primary" disabled={!canSubmit || sending}>
              {sending ? 'Sending…' : 'Send feedback'}
            </button>
            {!canSubmit && message.length > 0 && (
              <span className="settings-hint" style={{ margin: 0 }}>
                A few more words, please.
              </span>
            )}
          </div>

        </div>
      </fieldset>

      {error && (
        <p className="error-note" role="alert" style={{ margin: 0 }}>
          <span>
            {error}{' '}
            <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
              Open an issue on GitHub instead →
            </a>
          </span>
        </p>
      )}
    </form>
  );
}
