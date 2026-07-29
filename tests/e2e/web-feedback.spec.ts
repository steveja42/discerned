// Drives the /feedback form the way a user does: pick a type, type a message, submit.
//
// Both external dependencies are stubbed — the spec NEVER reaches GitHub or Cloudflare:
//   - /api/feedback is route-intercepted (it doesn't exist under `next dev` anyway,
//     since Netlify Functions aren't part of the Next dev server).
//   - The Turnstile script is replaced by a stub that immediately hands back a token,
//     so the spec doesn't depend on challenges.cloudflare.com being reachable.
//
// Screenshots land in test-output/ for human review of the layout.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'test-output');
mkdirSync(OUT, { recursive: true });

const ISSUE_URL = 'https://github.com/steveja42/discerned/issues/42';

/**
 * Replace Cloudflare's script with a stub exposing the same tiny surface the form uses
 * (render → callback(token), reset). Must be routed BEFORE navigation.
 */
async function stubTurnstile(page: Page) {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.turnstile = {
          render: (el, opts) => {
            el.setAttribute('data-stubbed', 'true');
            setTimeout(() => opts.callback('stub-token'), 0);
            return 'stub-widget';
          },
          reset: () => { /* no-op */ },
        };
      `,
    }));
}

/** Fulfil the feedback endpoint with a given status/body. */
async function stubApi(page: Page, body: unknown, status = 200) {
  await page.route('**/api/feedback', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

async function gotoFeedback(page: Page, query = '') {
  await stubTurnstile(page);
  await page.goto(`/feedback${query}`);
  await page.waitForLoadState('networkidle');
}

const messageBox = (page: Page) => page.locator('#feedback-message');
const submitBtn = (page: Page) => page.getByRole('button', { name: /send feedback/i });
/**
 * The form's own error line. Scoped to .relay-error because Next mounts its route
 * announcer with role="alert" too, which would make a bare [role=alert] ambiguous.
 */
const errorLine = (page: Page) => page.locator('.relay-error[role="alert"]');
/**
 * The radios are visually hidden and styled as chips, so a user clicks the LABEL —
 * .check() on the input itself fails as "not visible". Click the chip like a user does.
 */
const chip = (page: Page, group: 'type' | 'target', value: string) =>
  page.locator(`.feedback-chip:has(input[name="feedback-${group}"][value="${value}"])`);

test.describe('web feedback form', () => {
  test('renders both the form and the donate section', async ({ page }) => {
    await gotoFeedback(page);

    await expect(page.locator('h1')).toContainText('Tell us what');
    await expect(messageBox(page)).toBeVisible();
    await expect(page.locator('.donate-address')).toHaveText('stevus@getalby.com');
    await expect(page.locator('.donate-qr')).toBeVisible();

    await page.screenshot({ path: join(OUT, 'feedback-page.png'), fullPage: true });
  });

  test('defaults to the web app, and ?target=extension preselects the extension chip', async ({ page }) => {
    await gotoFeedback(page);
    await expect(page.locator('input[name="feedback-target"][value="web"]')).toBeChecked();

    await gotoFeedback(page, '?target=extension&v=0.2.0');
    await expect(page.locator('input[name="feedback-target"][value="extension"]')).toBeChecked();
    // The version stamp is surfaced to the user rather than sent invisibly.
    await expect(page.locator('.settings-hint').first()).toContainText('0.2.0');
  });

  test('an unknown ?target= falls back to the default instead of breaking', async ({ page }) => {
    await gotoFeedback(page, '?target=lolwut');
    await expect(page.locator('input[name="feedback-target"][value="web"]')).toBeChecked();
    await expect(messageBox(page)).toBeVisible();
  });

  test('submit stays disabled until the message is long enough', async ({ page }) => {
    await gotoFeedback(page);
    await expect(submitBtn(page)).toBeDisabled();

    await messageBox(page).fill('short');
    await expect(submitBtn(page)).toBeDisabled();

    await messageBox(page).fill('This is a long enough message to send.');
    await expect(submitBtn(page)).toBeEnabled();
  });

  test('a successful submit replaces the form with the issue link', async ({ page }) => {
    await gotoFeedback(page);
    await stubApi(page, { ok: true, issueUrl: ISSUE_URL, issueNumber: 42 });

    await messageBox(page).fill('Clipping a Substack post drops the footnotes.');
    await submitBtn(page).click();

    const success = page.locator('.feedback-success');
    await expect(success).toBeVisible();
    await expect(success).toContainText('issue #42');
    await expect(success.locator('a')).toHaveAttribute('href', ISSUE_URL);
    // Replacing the form (rather than showing a banner above it) is what prevents a
    // double-submit, so assert the form is really gone.
    await expect(messageBox(page)).toHaveCount(0);

    await page.locator('.feedback-success').screenshot({ path: join(OUT, 'feedback-success.png') });
  });

  test('sends the chosen type/target and the diagnostics with the request', async ({ page }) => {
    await gotoFeedback(page, '?target=extension&v=0.2.0');

    let posted: Record<string, unknown> | null = null;
    await page.route('**/api/feedback', async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await chip(page, 'type', 'bug').click();
    await expect(page.locator('input[name="feedback-type"][value="bug"]')).toBeChecked();
    await messageBox(page).fill('The overlay does not open on this page.');
    await submitBtn(page).click();
    await expect(page.locator('.feedback-success')).toBeVisible();

    expect(posted).toMatchObject({
      type: 'bug',
      target: 'extension',
      extVersion: '0.2.0',
      message: 'The overlay does not open on this page.',
      website: '', // honeypot left empty by a real interaction
      turnstileToken: 'stub-token',
    });
    expect(String(posted?.ua)).toContain('Mozilla');
  });

  test('a server error keeps the typed message and offers the GitHub fallback', async ({ page }) => {
    await gotoFeedback(page);
    await stubApi(page, { ok: false, error: 'Something went wrong on our end.' }, 500);

    await messageBox(page).fill('This message must survive a failed submit.');
    await submitBtn(page).click();

    const err = errorLine(page);
    await expect(err).toBeVisible();
    await expect(err).toContainText('Something went wrong');
    await expect(err.locator('a')).toHaveAttribute('href', /github\.com\/.*\/issues\/new/);

    // Never lose the user's typing, and let them retry.
    await expect(messageBox(page)).toHaveValue('This message must survive a failed submit.');
    await expect(submitBtn(page)).toBeEnabled();
  });

  test('a failed submit can be retried successfully', async ({ page }) => {
    await gotoFeedback(page);

    // Fail once, then succeed — covers the Turnstile stale-token reset, which only
    // shows up on the SECOND attempt.
    let calls = 0;
    await page.route('**/api/feedback', async (route) => {
      calls += 1;
      await (calls === 1
        ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Verification failed. Please try again.' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, issueUrl: ISSUE_URL, issueNumber: 43 }) }));
    });

    await messageBox(page).fill('Retrying after a verification failure.');
    await submitBtn(page).click();
    await expect(errorLine(page)).toContainText('Verification failed');

    await submitBtn(page).click();
    await expect(page.locator('.feedback-success')).toContainText('issue #43');
    expect(calls).toBe(2);
  });

  test('the honeypot is present but unreachable by keyboard', async ({ page }) => {
    await gotoFeedback(page);

    const honeypot = page.locator('#feedback-website');
    await expect(honeypot).toHaveCount(1);
    await expect(honeypot).toHaveAttribute('tabindex', '-1');
    // Offscreen rather than display:none — some bots skip hidden inputs.
    await expect(honeypot).not.toBeInViewport();
  });
});
