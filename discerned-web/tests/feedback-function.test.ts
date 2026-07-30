// Drives the REAL Netlify function handler (netlify/functions/feedback.mts) with the two
// upstream calls stubbed, so every branch is exercised without touching Cloudflare or
// GitHub. Vitest is used rather than a standalone harness because `netlify dev` wants
// port 3000 (fighting the dev server) and tsx mis-resolves the shared .ts import that
// Netlify's esbuild handles correctly.
//
// The branches that matter most here are the ones a manual curl pass would skip:
// never-fail-open on a missing secret, and the honeypot's fake success.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The handler reads process.env at call time, so each test can set it up front.
const ORIGINAL_ENV = { ...process.env };

type Outcome = {
  turnstile?: 'pass' | 'fail' | 'unreachable';
  github?: 201 | 422 | 404 | 'unreachable';
};
let outcome: Outcome = {};
let githubBodies: string[] = [];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    if (url.includes('challenges.cloudflare.com')) {
      if (outcome.turnstile === 'unreachable') throw new Error('simulated network failure');
      const success = outcome.turnstile !== 'fail';
      return new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.includes('api.github.com')) {
      githubBodies.push(String(init?.body ?? ''));
      if (outcome.github === 'unreachable') throw new Error('simulated network failure');
      if (outcome.github === 422) {
        // GitHub's real shape when a label doesn't exist on the repo.
        return new Response(JSON.stringify({
          message: 'Validation Failed',
          errors: [{ resource: 'Label', field: 'name', code: 'invalid' }],
        }), { status: 422 });
      }
      if (outcome.github === 404) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ html_url: 'https://github.com/steveja42/discerned/issues/42', number: 42 }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }

    throw new Error(`unexpected fetch to ${url}`);
  }));
}

// Fresh module per test: the handler holds a module-level rate-limit Map, so without this
// the limiter would leak state between cases.
async function loadHandler() {
  vi.resetModules();
  const mod = await import('../netlify/functions/feedback.mts');
  return mod.default;
}

const VALID = {
  type: 'bug', target: 'extension', message: 'The overlay does not open on this page.',
  website: '', turnstileToken: 'tok',
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://discerned.online/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// A distinct IP per call keeps the 3-per-10-min limiter out of the way except where tested.
let ipCounter = 0;
const ctx = () => ({ ip: `198.51.100.${++ipCounter % 250}` });

describe('feedback function', () => {
  beforeEach(() => {
    outcome = {};
    githubBodies = [];
    ipCounter = 0;
    process.env = { ...ORIGINAL_ENV, TURNSTILE_SECRET_KEY: 'secret', GITHUB_FEEDBACK_TOKEN: 'token' };
    stubFetch();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('files an issue on the happy path', async () => {
    const handler = await loadHandler();
    const res = await handler(post(VALID), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, issueNumber: 42 });

    const sent = JSON.parse(githubBodies[0]);
    expect(sent.title).toBe('[bug] The overlay does not open on this page.');
    expect(sent.labels).toEqual(['feedback', 'bug', 'area:extension']);
    expect(sent.body).toContain('| Area | Extension |');
  });

  // The label set is the 422 tripwire: 'idea' must go out as GitHub's default
  // 'enhancement' label, not as the literal form value.
  it('files an idea as enhancement, not as "idea"', async () => {
    const handler = await loadHandler();
    const res = await handler(post({ ...VALID, type: 'idea', target: 'web' }), ctx());
    expect(res.status).toBe(200);

    const sent = JSON.parse(githubBodies[0]);
    expect(sent.labels).toEqual(['feedback', 'enhancement', 'area:web']);
    expect(sent.title).toMatch(/^\[idea\] /); // the TITLE still uses our vocabulary
  });

  it('rejects a non-POST with 405 and an Allow header', async () => {
    const handler = await loadHandler();
    const res = await handler(new Request('https://discerned.online/api/feedback'), ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('answers OPTIONS preflight for an allowed origin only', async () => {
    const handler = await loadHandler();
    const allowed = await handler(new Request('https://discerned.online/api/feedback', {
      method: 'OPTIONS', headers: { origin: 'https://discerned.online' },
    }), ctx());
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://discerned.online');

    const denied = await handler(new Request('https://discerned.online/api/feedback', {
      method: 'OPTIONS', headers: { origin: 'https://evil.example' },
    }), ctx());
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  // The honeypot must look like success AND must not reach GitHub.
  it('fakes success for a filled honeypot without filing anything', async () => {
    const handler = await loadHandler();
    const res = await handler(post({ ...VALID, website: 'http://spam.example' }), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(githubBodies).toHaveLength(0);
  });

  it('rejects a too-short message and a bad type before any upstream call', async () => {
    const handler = await loadHandler();
    expect((await handler(post({ ...VALID, message: 'short' }), ctx())).status).toBe(400);
    expect((await handler(post({ ...VALID, type: 'urgent' }), ctx())).status).toBe(400);
    expect(githubBodies).toHaveLength(0);
  });

  it('rejects a missing Turnstile token', async () => {
    const handler = await loadHandler();
    const res = await handler(post({ ...VALID, turnstileToken: '' }), ctx());
    expect(res.status).toBe(400);
    expect(githubBodies).toHaveLength(0);
  });

  it('rejects a Turnstile failure with 400, and reports unreachable as 502', async () => {
    const handler = await loadHandler();

    outcome.turnstile = 'fail';
    const failed = await handler(post(VALID), ctx());
    expect(failed.status).toBe(400);
    await expect(failed.json()).resolves.toMatchObject({ error: expect.stringContaining('Verification failed') });

    // Distinct from a rejection: a user holding a good token must not be told to retry forever.
    outcome.turnstile = 'unreachable';
    const down = await handler(post(VALID), ctx());
    expect(down.status).toBe(502);
    expect(githubBodies).toHaveLength(0);
  });

  // The regression that would otherwise be discovered via spam.
  it('NEVER fails open when TURNSTILE_SECRET_KEY is missing', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const handler = await loadHandler();
    const res = await handler(post(VALID), ctx());
    expect(res.status).toBe(500);
    expect(githubBodies).toHaveLength(0); // critically: did NOT accept the submission
    // Naming the variable is the point — a generic "unavailable" for either of two
    // missing vars means digging through function logs to tell them apart.
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('TURNSTILE_SECRET_KEY'),
    });
  });

  it('returns 500 naming GITHUB_FEEDBACK_TOKEN when it is missing', async () => {
    delete process.env.GITHUB_FEEDBACK_TOKEN;
    const handler = await loadHandler();
    const res = await handler(post(VALID), ctx());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('GITHUB_FEEDBACK_TOKEN'),
    });
  });

  // The two setup mistakes must be told apart. Both used to read as one generic failure,
  // which costs a debugging round-trip each.
  it('names the missing labels on a GitHub 422', async () => {
    outcome.github = 422;
    const handler = await loadHandler();
    const res = await handler(post(VALID), ctx());
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/label/i);
    expect(body.error).toContain('area:extension'); // lists what to create
  });

  it('points at the token on a GitHub 404 (fine-grained PATs mask 403 as 404)', async () => {
    outcome.github = 404;
    const handler = await loadHandler();
    const res = await handler(post(VALID), ctx());
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('GITHUB_FEEDBACK_TOKEN');
    expect(body.error).toContain('steveja42/discerned');
  });

  it('rate-limits the 4th submission from one IP', async () => {
    const handler = await loadHandler();
    const sameIp = { ip: '203.0.113.7' };
    for (let i = 0; i < 3; i++) {
      expect((await handler(post(VALID), sameIp)).status).toBe(200);
    }
    const fourth = await handler(post(VALID), sameIp);
    expect(fourth.status).toBe(429);
  });

  it('neuters mentions and issue refs in the filed body', async () => {
    const handler = await loadHandler();
    await handler(post({ ...VALID, message: 'cc @steveja42 — this fixes #9 maybe', contact: 'a@b.com' }), ctx());
    const sent = JSON.parse(githubBodies[0]);
    expect(sent.body).toContain('@​steveja42');
    expect(sent.body).toContain('#​9');
    expect(sent.body).toContain('| Contact | a@b.com |'); // email must survive intact
  });

  it('sets no-store on responses', async () => {
    const handler = await loadHandler();
    const res = await handler(post(VALID), ctx());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
