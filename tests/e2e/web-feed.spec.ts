// Mocks the public Nostr relay subscription used by HomeClient by intercepting
// every wss:// WebSocket. On REQ, responds with a single signed Wirthy
// kind:1 event and EOSE. Asserts the event renders on the home feed.

import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/core';

function buildFixtureEvent() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['r', 'https://example.com/test-cast'],
      ['L', 'app.wirthy.signal'],
      ['l', 'Masterpiece', 'app.wirthy.signal'],
      ['L', 'app.wirthy.qualifier'],
      ['l', 'Timeless', 'app.wirthy.qualifier'],
      ['L', 'app.wirthy.category'],
      ['l', 'Science', 'app.wirthy.category'],
      ['t', 'wirthy'],
      ['format', 'article'],
      ['client', 'wirthy'],
    ],
    content: 'Wirthy: ★★★★★ Masterpiece in Science\n\nA Mocked Cast Title\nhttps://example.com/test-cast',
  };
  return { event: finalizeEvent(template, sk), pk };
}

test.describe('public feed — mocked Nostr relay', () => {
  test('renders a clip from a mocked relay subscription', async ({ page }) => {
    const { event } = buildFixtureEvent();

    // Force production relay mode so the feed opens wss:// sockets we can
    // intercept. In dev the NEXT_PUBLIC_LOCAL_RELAY env var makes the feed
    // subscribe to ws://localhost:7777 instead, which bypasses the mock (and,
    // when the local relay is running, floods the feed with real test casts).
    await page.addInitScript(() => {
      try { localStorage.setItem('wirthy.relayMode', 'production'); } catch { /* ignore */ }
    });

    // Intercept any wss:// connection HomeClient opens via SimplePool.
    await page.routeWebSocket(/^wss:\/\//, (ws) => {
      ws.onMessage((message: string | Buffer) => {
        const msg = typeof message === 'string' ? message : message.toString();
        try {
          const parsed = JSON.parse(msg);
          if (Array.isArray(parsed) && parsed[0] === 'REQ') {
            const subId = parsed[1];
            ws.send(JSON.stringify(['EVENT', subId, event]));
            ws.send(JSON.stringify(['EOSE', subId]));
          }
        } catch {
          // Ignore non-JSON frames (e.g. CLOSE).
        }
      });
    });

    await page.goto('/home');
    // The feed renders one <article class="clip"> per kind:1 event. Scope to
    // that container — the title shows up in multiple child elements (.clip-title
    // and .clip-excerpt/.clip-note), so a page-wide getByText would be ambiguous.
    await expect(
      page.locator('article.clip', { hasText: 'A Mocked Cast Title' }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
