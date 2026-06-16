// Nostr relay subscription for the public Cast feed.
// Subscribes to kind:1 events tagged #discerned across the default relay set.
// Returns a cleanup function that closes the subscription and pool on unmount.

import { SimplePool, type Event, type Filter } from 'nostr-tools';
import { getActiveRelays } from '@/lib/constants';
import { LL, log } from '@/lib/logger';

export function subscribeFeed(
  onEvent: (e: Event) => void,
  onEose: () => void,
): () => void {
  const relays = [...getActiveRelays()];
  log(LL.NORMAL, `[nostr] subscribeFeed connecting to ${relays.length} relay(s):`, relays);
  const pool = new SimplePool();
  const filter: Filter = { kinds: [1], '#t': ['discerned'], limit: 50 };
  const sub = pool.subscribeMany(
    relays,
    filter,
    {
      onevent: onEvent,
      oneose: () => {
        log(LL.NORMAL, '[nostr] subscribeFeed EOSE from', relays);
        onEose();
      },
    },
  );

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    sub.close();
    // destroy() tears down all relay connections cleanly regardless of their
    // current WebSocket readyState, avoiding "already CLOSING or CLOSED"
    // warnings from React Strict Mode's double effect invocation in dev.
    pool.destroy();
  };
}
