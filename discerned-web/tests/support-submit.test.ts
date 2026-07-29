// submitFeedback()'s error mapping. The value here is that every failure resolves to a
// { ok: false, error } the UI can show — it must never throw — and that a NON-JSON response
// is diagnosed correctly. That last case is what a developer actually hits first: Netlify
// Functions don't run under `next dev`, so /api/feedback returns Next's HTML 404 page, and
// a bare "(404)" would read like a GitHub token problem instead of "no function here".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitFeedback } from '@/lib/support';

const PAYLOAD = { type: 'bug', target: 'web', message: 'a long enough message' } as const;

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
/** What Next's dev server (or a proxy error page) actually returns: HTML, not JSON. */
function htmlRes(status: number) {
  return new Response('<!doctype html><h1>404</h1>', { status, headers: { 'content-type': 'text/html' } });
}

describe('submitFeedback', () => {
  beforeEach(() => {
    // jsdom defaults to localhost, which is the "local dev" branch.
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, issueUrl: 'u', issueNumber: 1 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the issue details on success', async () => {
    await expect(submitFeedback({ ...PAYLOAD })).resolves.toEqual({ ok: true, issueUrl: 'u', issueNumber: 1 });
  });

  it('surfaces the function’s own error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false, error: 'Verification failed.' }, 400)));
    await expect(submitFeedback({ ...PAYLOAD })).resolves.toEqual({ ok: false, error: 'Verification failed.' });
  });

  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const r = await submitFeedback({ ...PAYLOAD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/connection/i);
  });

  // The regression this file exists for.
  it('explains a 404 as a missing local function, not a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlRes(404)));
    const r = await submitFeedback({ ...PAYLOAD });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/don’t run under `next dev`|isn’t running locally/);
      expect(r.error).not.toMatch(/^Couldn’t send that\. Please try again\. \(404\)$/);
    }
  });

  it('falls back to a status-tagged message for other non-JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlRes(502)));
    const r = await submitFeedback({ ...PAYLOAD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('(502)');
  });
});
