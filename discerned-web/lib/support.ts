// Support surface constants + the feedback submit call. Kept separate from constants.ts,
// which is Nostr axis vocabulary and relay-mode machinery with no overlap.
//
// See discerned-web/CLAUDE.md → Feedback function.

import { LL, log } from '@/lib/logger';
import type { FeedbackPayload } from '@/lib/feedback-format';

// ── Donations ────────────────────────────────────────────────────────────────

export const LIGHTNING_ADDRESS = 'stevus@getalby.com';
/** What the QR encodes and what "Open in wallet" links to — wallet scanners expect the URI form. */
export const LIGHTNING_URI = `lightning:${LIGHTNING_ADDRESS}`;
/**
 * Committed build-time asset (public/support/lightning-qr.svg), NOT generated at runtime.
 * Under `output: 'export'` the QR is a constant, so a runtime QR dependency would buy nothing.
 * Regenerate with `pnpm gen:qr` after changing LIGHTNING_ADDRESS.
 */
export const LIGHTNING_QR_SRC = '/support/lightning-qr.svg';

/** PayPal merchant account ID. Public by design — it's what the donate button posts to. */
export const PAYPAL_BUSINESS_ID = 'W8CNL6D983WVS';
export const PAYPAL_SDK_SRC = 'https://www.paypalobjects.com/donate/sdk/donate-sdk.js';
export const PAYPAL_BUTTON_IMAGE = 'https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif';

// ── Project links ────────────────────────────────────────────────────────────

export const SITE_URL = 'https://discerned.online';
export const GITHUB_REPO_URL = 'https://github.com/steveja42/discerned';
/** Manual fallback offered whenever the function fails — the user always has a path. */
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues/new`;

// ── Turnstile ────────────────────────────────────────────────────────────────

export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
/**
 * The site key is public by design (it ships to the browser); the SECRET half lives only
 * in the Netlify function env. Falls back to Cloudflare's documented always-passes test key
 * so the form is usable in local dev before real keys are configured.
 */
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

// ── Feedback endpoint ────────────────────────────────────────────────────────

/**
 * Netlify Functions don't exist under `next dev`, so point at a locally-served function
 * when NEXT_PUBLIC_FUNCTIONS_ORIGIN is set (see .env.example). Same env-var-supplies-the-
 * dev-override idiom as NEXT_PUBLIC_LOCAL_RELAY in constants.ts. In production this is the
 * same-origin /api/feedback alias (netlify.toml redirect), not /.netlify/functions/* —
 * that well-known path is filtered by some blockers and corporate proxies.
 */
export const FEEDBACK_ENDPOINT = process.env.NEXT_PUBLIC_FUNCTIONS_ORIGIN
  ? `${process.env.NEXT_PUBLIC_FUNCTIONS_ORIGIN.replace(/\/$/, '')}/feedback`
  : '/api/feedback';

export type FeedbackResult =
  | { ok: true; issueUrl?: string; issueNumber?: number }
  | { ok: false; error: string };

const GENERIC_ERROR = 'Couldn’t send that. Please try again.';

/**
 * POST the feedback form. Never throws — every failure path resolves to { ok: false }
 * with a message safe to show the user, so the caller only handles one shape.
 */
export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
  let res: Response;
  try {
    res = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    log(LL.WARN, '[feedback] network error posting to', FEEDBACK_ENDPOINT, err);
    return { ok: false, error: 'Couldn’t reach the server. Check your connection and try again.' };
  }

  // A non-JSON body means the FUNCTION never answered — it returns JSON on every path,
  // including its own errors. Something else replied: Next's dev-server 404 page, a proxy,
  // or a platform error page. Distinguish the common dev case explicitly, because a bare
  // "(404)" reads like a GitHub/token problem when it is really "no function here".
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    log(LL.WARN, '[feedback] non-JSON response from', FEEDBACK_ENDPOINT, '— status', res.status);
    if (res.status === 404) {
      const isLocal = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
      return {
        ok: false,
        error: isLocal
          // Netlify Functions aren't part of `next dev` — see .env.example.
          ? 'The feedback endpoint isn’t running locally. Netlify Functions don’t run under `next dev` — set NEXT_PUBLIC_FUNCTIONS_ORIGIN, or use the deployed site.'
          : 'The feedback service isn’t available right now. Please open an issue on GitHub instead.',
      };
    }
    return { ok: false, error: res.ok ? GENERIC_ERROR : `${GENERIC_ERROR} (${res.status})` };
  }

  const body = (data ?? {}) as { ok?: boolean; error?: string; issueUrl?: string; issueNumber?: number };
  if (res.ok && body.ok) {
    return { ok: true, issueUrl: body.issueUrl, issueNumber: body.issueNumber };
  }
  return { ok: false, error: body.error || GENERIC_ERROR };
}
