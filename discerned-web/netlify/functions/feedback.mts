// Feedback intake → GitHub issue.
//
// The web app is a static export (next.config.ts → output: 'export'), so there are no
// API routes or server actions — this function is the ONLY server-side code in the app.
// It exists so the feedback form has somewhere to POST that can hold a GitHub token.
//
// .mts (not .ts) selects Netlify's v2 runtime: standard Request/Response, ESM.
// Reached at /api/feedback via the netlify.toml redirect, not /.netlify/functions/*.
//
// See discerned-web/CLAUDE.md → Feedback function.

import {
  validatePayload, deriveIssueTitle, deriveIssueLabels, buildIssueBody,
} from '../../lib/feedback-format.ts';

// Minimal local shapes for the two v2-runtime types we touch. Declared here rather than
// importing @netlify/functions: that package would be a dependency carried solely for two
// type annotations, and Netlify injects the real runtime at deploy time regardless.
interface Context { ip?: string }
interface Config { path: string }

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'steveja42/discerned';

// The two upstream calls run sequentially and Netlify's synchronous limit is 10s, so
// these budgets must sum to less than that with room for our own work.
const TURNSTILE_TIMEOUT_MS = 5_000;
const GITHUB_TIMEOUT_MS = 8_000;

// Origins allowed to call this cross-origin. The page itself is same-origin (the
// /api/feedback alias), so this is really for the extension, which may POST directly
// later rather than opening a tab. Never '*'.
const ALLOWED_ORIGINS = new Set([
  'https://discerned.online',
  'http://localhost:3000',
  // Pinned extension ID (manifest.json "key") — stable across rebuilds.
  'chrome-extension://egocpdhpffaddnhjimclgabdhpbjbhod',
]);

// ── Rate limiting ────────────────────────────────────────────────────────────
// BEST-EFFORT ONLY. Netlify Functions are per-instance and scale horizontally, so this
// Map is not shared across concurrent instances and a determined attacker routes around
// it. Turnstile carries the real anti-abuse load; this layer exists for the case Turnstile
// does NOT cover — a human who solves challenges and submits repeatedly. Don't delete it
// as redundant, and don't mistake it for the primary defence. Escalation path if abuse
// appears: Netlify Blobs for shared state.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 3;
const recentByIp = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  // Sweep stale entries on every invocation so the Map can't grow unbounded on a
  // long-lived instance.
  for (const [key, times] of recentByIp) {
    const live = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length === 0) recentByIp.delete(key);
    else recentByIp.set(key, live);
  }
  const hits = recentByIp.get(ip) ?? [];
  if (hits.length >= RATE_MAX) return true;
  recentByIp.set(ip, [...hits, now]);
  return false;
}

// ── Responses ────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

const fail = (error: string, status: number, origin: string | null) =>
  json({ ok: false, error }, status, origin);

// ── Turnstile ────────────────────────────────────────────────────────────────

type VerifyOutcome = 'pass' | 'reject' | 'unreachable';

async function verifyTurnstile(token: string, ip: string, secret: string): Promise<VerifyOutcome> {
  const form = new URLSearchParams({ secret, response: token });
  // remoteip is optional and Cloudflare rejects a malformed one, so only send a real value.
  if (ip) form.set('remoteip', ip);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return 'unreachable';
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success) return 'pass';
    console.warn('[feedback] turnstile rejected:', data['error-codes']);
    return 'reject';
  } catch (err) {
    // Network error or timeout — distinct from "Cloudflare says this token is bad".
    // Conflating the two would tell a user holding a valid token to retry forever.
    console.error('[feedback] turnstile unreachable:', err);
    return 'unreachable';
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: Request, context: Context): Promise<Response> {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed.' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST', ...corsHeaders(origin) },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('Malformed request.', 400, origin);
  }

  // Cheap structural checks first (honeypot, types, lengths, spam heuristics) — a bot
  // should never cost us a network round-trip to Cloudflare or GitHub.
  const validated = validatePayload(body);
  if (!validated.ok) {
    // Honeypot: answer as if it succeeded. A 400 would teach the bot which field is the trap.
    if (validated.silent) return json({ ok: true }, 200, origin);
    return fail(validated.error, 400, origin);
  }
  const { type, target, message, contact, extVersion, ua } = validated.value;

  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || '';
  if (ip && rateLimited(ip)) {
    return fail('Too many submissions. Please try again in a few minutes.', 429, origin);
  }

  // NEVER FAIL OPEN. A deploy missing the secret must reject, not silently accept
  // everything — that failure mode gets discovered via spam.
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (!turnstileSecret) {
    console.error('[feedback] TURNSTILE_SECRET_KEY is not set — refusing to accept submissions');
    return fail('Feedback is temporarily unavailable.', 500, origin);
  }

  const turnstileToken =
    typeof (body as { turnstileToken?: unknown }).turnstileToken === 'string'
      ? (body as { turnstileToken: string }).turnstileToken
      : '';
  if (!turnstileToken) {
    return fail('Verification is still loading. Please try again in a moment.', 400, origin);
  }

  const outcome = await verifyTurnstile(turnstileToken, ip, turnstileSecret);
  if (outcome === 'reject') {
    return fail('Verification failed. Please try again.', 400, origin);
  }
  if (outcome === 'unreachable') {
    return fail('Couldn’t verify your submission. Please try again, or open an issue on GitHub.', 502, origin);
  }

  const githubToken = process.env.GITHUB_FEEDBACK_TOKEN;
  if (!githubToken) {
    console.error('[feedback] GITHUB_FEEDBACK_TOKEN is not set');
    return fail('Feedback is temporarily unavailable.', 500, origin);
  }
  const repo = process.env.GITHUB_FEEDBACK_REPO || DEFAULT_REPO;

  // NOTE: every label below must ALREADY EXIST on the repo — GitHub rejects the whole
  // request with 422 if any is unknown. `bug` and `enhancement` (which 'idea' maps to)
  // are GitHub defaults; the ones that must be created by hand are: feedback, other,
  // area:extension, area:web, area:both. See deriveIssueLabels in lib/feedback-format.ts.
  const issue = {
    title: deriveIssueTitle(type, message),
    body: buildIssueBody({ type, target, message, contact, extVersion, ua }),
    labels: deriveIssueLabels(type, target),
  };

  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'discerned-feedback',
      },
      body: JSON.stringify(issue),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[feedback] GitHub issue creation failed:', res.status, detail.slice(0, 500));
      // 422 here almost always means a label doesn't exist on the repo.
      return fail('Couldn’t file that. Please try again, or open an issue on GitHub.', 502, origin);
    }

    const created = (await res.json()) as { html_url?: string; number?: number };
    return json({ ok: true, issueUrl: created.html_url, issueNumber: created.number }, 200, origin);
  } catch (err) {
    console.error('[feedback] GitHub request error:', err);
    return fail('Couldn’t reach GitHub. Please try again, or open an issue directly.', 502, origin);
  }
}

export const config: Config = { path: '/api/feedback' };
