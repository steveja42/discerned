// Nostr follow-list subscription for the signed-in user.
// Reads the user's NIP-02 contact list (kind:3), then fetches kind:0 profile
// metadata (name / picture) for each followed pubkey. Emits the follow list as
// profiles arrive. Returns a cleanup function mirroring subscribeFeed's teardown.

import { SimplePool, type Event, type Filter } from 'nostr-tools';
import { npubEncode } from 'nostr-tools/nip19';
import { ACTIVE_RELAYS } from '@/lib/constants';
import { LL, log } from '@/lib/logger';

export interface FollowProfile {
  pubkey: string;
  name?: string;
  picture?: string;
}

function parseProfileContent(content: string): { name?: string; picture?: string } {
  try {
    const meta = JSON.parse(content) as { name?: string; display_name?: string; picture?: string };
    return { name: meta.display_name || meta.name, picture: meta.picture };
  } catch {
    return {};
  }
}

export function subscribeFollowList(
  pubkey: string,
  onUpdate: (follows: FollowProfile[]) => void,
): () => void {
  const pool = new SimplePool();
  const relays = [...ACTIVE_RELAYS];
  log(LL.NORMAL, '[nostr] subscribeFollowList connecting to', relays, 'for', npubEncode(pubkey).slice(0, 12));
  let closed = false;
  const subs: { close: () => void }[] = [];

  // pubkey -> profile; preserves contact-list order via `order`.
  const profiles = new Map<string, FollowProfile>();
  const order: string[] = [];

  const emit = () => {
    if (closed) return;
    onUpdate(order.map((pk) => profiles.get(pk) ?? { pubkey: pk }));
  };

  const contactFilter: Filter = { kinds: [3], authors: [pubkey], limit: 1 };
  const contactSub = pool.subscribeMany(relays, contactFilter, {
    onevent: (e: Event) => {
      if (closed) return;
      const followed = e.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]);
      for (const pk of followed) {
        if (!profiles.has(pk)) {
          profiles.set(pk, { pubkey: pk });
          order.push(pk);
        }
      }
      emit();

      if (followed.length > 0) {
        const metaFilter: Filter = { kinds: [0], authors: followed };
        const metaSub = pool.subscribeMany(relays, metaFilter, {
          onevent: (m: Event) => {
            if (closed) return;
            profiles.set(m.pubkey, { pubkey: m.pubkey, ...parseProfileContent(m.content) });
            emit();
          },
          oneose: () => { /* keep open for late profiles */ },
        });
        subs.push(metaSub);
      }
    },
    oneose: () => { /* keep open in case the contact list updates */ },
  });
  subs.push(contactSub);

  return () => {
    if (closed) return;
    closed = true;
    subs.forEach((s) => s.close());
    pool.destroy();
  };
}
