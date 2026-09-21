// Nostr relay subscription for the public Cast feed.
// Subscribes to kind:1 notes AND kind:30023 long-form articles tagged #discerned
// across the default relay set. Returns a cleanup function that closes the
// subscription and pool on unmount.

import { SimplePool, type Event, type Filter } from 'nostr-tools';
import { getActiveRelays, getShowTestCasts } from '@/lib/constants';
import { TEST_CAST_PUBKEY } from '@/lib/nostr/test-cast-author';
import { LL, log } from '@/lib/logger';

const FEED_LIMIT = 50;

// A companion kind-1 note (summary + link) and its kind-30023 long-form are two
// EVENTS but one CLIP — useCastFeed's dedupKey() collapses them once parsed.
// The backfill walk below must count in that same unit, or a page of 50 raw
// events (~25 note/long-form pairs) satisfies FEED_LIMIT while only ~25 clips
// actually reach the feed. Mirrors dedupKey() in hooks/useCastFeed.ts on raw
// tags instead of a parsed ClipData — kept in sync by rawDedupKey.test.ts.
export function rawDedupKey(e: Event): string {
  if (e.kind === 30023) {
    const d = e.tags.find((t) => t[0] === 'd')?.[1];
    return d ? `${e.pubkey}:${d}` : e.id;
  }
  const aTag = e.tags.find((t) => t[0] === 'a')?.[1];
  const longFormId = aTag?.startsWith('30023:') ? aTag.split(':')[2] : undefined;
  return longFormId ? `${e.pubkey}:${longFormId}` : e.id;
}

export function subscribeFeed(
  onEvent: (e: Event) => void,
  onEose: () => void,
): () => void {
  const relays = [...getActiveRelays()];
  const showTestCasts = getShowTestCasts();
  log(LL.NORMAL, `[nostr] subscribeFeed connecting to ${relays.length} relay(s) (test casts ${showTestCasts ? 'shown' : 'hidden'}):`, relays);
  const pool = new SimplePool();

  let closed = false;
  let sub: { close: () => void } | undefined;

  // A NIP-01 filter has no "author != X" — only allowlists — so hiding test casts
  // can't be done relay-side. Applying the filter AFTER a `limit: 50` REQ instead
  // (the first cut of this) undercounts: the local relay's newest 50 events can be
  // almost entirely a corpus-sweep burst (measured 2026-09-21: 242 test casts vs 258
  // real ones in the newest 500), leaving as few as 7 real casts in view. So when
  // test casts are hidden, page backwards with `until` — each REQ still asks for
  // FEED_LIMIT, but a round that comes back all-test doesn't stop the walk; it
  // continues until FEED_LIMIT real events are collected or a round returns empty
  // (genuinely nothing older left). MAX_PAGES bounds how far back a pathological
  // backlog (e.g. a much bigger future sweep) can make this walk.
  if (!showTestCasts) {
    const MAX_PAGES = 20;
    const collectedKeys = new Set<string>();
    let until: number | undefined;
    let page = 0;

    const nextPage = () => {
      page += 1;
      const filter: Filter = {
        kinds: [1, 30023],
        '#t': ['discerned'],
        limit: FEED_LIMIT,
        ...(until !== undefined ? { until } : {}),
      };
      let sawAny = false;
      let oldest: number | undefined;
      sub = pool.subscribeMany(relays, filter, {
        onevent: (e) => {
          if (closed) return;
          sawAny = true;
          oldest = oldest === undefined ? e.created_at : Math.min(oldest, e.created_at);
          if (e.pubkey === TEST_CAST_PUBKEY) return;
          collectedKeys.add(rawDedupKey(e));
          onEvent(e);
        },
        oneose: () => {
          if (closed) return;
          sub?.close();
          const exhausted = !sawAny || oldest === undefined;
          if (collectedKeys.size >= FEED_LIMIT || exhausted || page >= MAX_PAGES) {
            log(LL.NORMAL, `[nostr] subscribeFeed backfill done from ${relays.join(',')} (${collectedKeys.size} real clip(s) after filtering test casts, ${page} page(s))`);
            onEose();
            startLiveTail();
            return;
          }
          // This round existed but didn't fill the quota — page further back.
          // (oldest is defined here: exhausted is false, and exhausted is
          // true whenever oldest is undefined.)
          until = (oldest as number) - 1;
          nextPage();
        },
      });
    };

    // Once the backfill walk satisfies FEED_LIMIT (or runs out of history), leave
    // one open-ended subscription running so new casts published after this point
    // still stream in live — mirrors the single always-open subscribeMany below.
    const startLiveTail = () => {
      if (closed) return;
      const filter: Filter = { kinds: [1, 30023], '#t': ['discerned'], since: Math.floor(Date.now() / 1000) };
      sub = pool.subscribeMany(relays, filter, {
        onevent: (e) => {
          if (closed) return;
          if (e.pubkey === TEST_CAST_PUBKEY) return;
          onEvent(e);
        },
        oneose: () => {},
      });
    };

    nextPage();
  } else {
    const filter: Filter = { kinds: [1, 30023], '#t': ['discerned'], limit: FEED_LIMIT };
    sub = pool.subscribeMany(relays, filter, {
      onevent: onEvent,
      oneose: () => {
        log(LL.NORMAL, '[nostr] subscribeFeed EOSE from', relays);
        onEose();
      },
    });
  }

  return () => {
    if (closed) return;
    closed = true;
    sub?.close();
    // destroy() tears down all relay connections cleanly regardless of their
    // current WebSocket readyState, avoiding "already CLOSING or CLOSED"
    // warnings from React Strict Mode's double effect invocation in dev.
    pool.destroy();
  };
}
