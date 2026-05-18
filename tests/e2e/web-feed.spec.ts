// Mocks the public Nostr relay subscription used by HomeClient by intercepting
// every wss:// WebSocket. On REQ, responds with a single signed Discerned
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
      ['L', 'online.discerned.interest'],
      ['L', 'online.discerned.ethics'],
      ['L', 'online.discerned.category'],
      ['l', 'Wise', 'online.discerned.interest'],
      ['l', 'Honest', 'online.discerned.ethics'],
      ['l', 'Science', 'online.discerned.category'],
      ['t', 'discerned'],
      ['format', 'article'],
      ['client', 'discerned'],
    ],
    content: 'Discerned: Wise / Honest — Science\n\nA Mocked Cast Title\nhttps://example.com/test-cast',
  };
  return { event: finalizeEvent(template, sk), pk };
}

test.describe('public feed — mocked Nostr relay', () => {
  test('renders a clip from a mocked relay subscription', async ({ page }) => {
    const { event } = buildFixtureEvent();

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

    await page.goto('/');
    // The feed renders one <article class="clip"> per kind:1 event. Scope to
    // that container — the title shows up in multiple child elements (.clip-title
    // and .clip-excerpt/.clip-note), so a page-wide getByText would be ambiguous.
    await expect(
      page.locator('article.clip', { hasText: 'A Mocked Cast Title' }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
