#!/usr/bin/env node
// Delete every cast the test suite published to the LOCAL relay.
//
// Why this is needed: the local relay (tools/nostr-relay) is a persistent SQLite
// store — nothing expires — and the cast-render path publishes a real event for
// every domain it renders. A full corpus sweep adds ~200. They accumulate run
// after run, and the feed's subscription is capped at `limit: 50`, so a big
// enough backlog can push a freshly published cast out of the window the feed
// actually renders.
//
// Every test cast is signed with ONE fixed key (TEST_CAST_SECRET_KEY in
// helpers/castFromCapture.ts), so they are identifiable by author and deletable
// by the standard mechanism: a NIP-09 kind-5 signed with that same key. No
// database surgery, and no risk to anything a real user published — a cast from
// any other author is untouched by construction.
//
// Usage:
//   node tests/e2e/tools/purge-test-casts.mjs --dry-run   # count them, delete nothing
//   node tests/e2e/tools/purge-test-casts.mjs             # delete them

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const RELAY = process.env.DISCERNED_LOCAL_RELAY ?? 'ws://localhost:7777';
const DRY = process.argv.includes('--dry-run');

// Must match TEST_CAST_SECRET_KEY in tests/e2e/helpers/castFromCapture.ts.
// Duplicated rather than imported because this is a plain .mjs script and the
// helper is TypeScript. Guarded by tests/e2e/tools/purge-test-casts.test.ts,
// which fails if the two definitions ever drift — silent drift here would make
// the tool cheerfully report "nothing to do" while the casts piled up.
const TEST_CAST_SECRET_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff),
);
const TEST_PUBKEY = getPublicKey(TEST_CAST_SECRET_KEY);

function query(filter) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const found = [];
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } resolve(found); }, 15_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['REQ', 'purge', filter])));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg[0] === 'EVENT') found.push(msg[2]);
      if (msg[0] === 'EOSE') { clearTimeout(timer); try { ws.close(); } catch { /* */ } resolve(found); }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cannot reach ${RELAY} — is the local relay running? (pnpm relay:local)`));
    });
  });
}

function publish(event) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('no ACK')); }, 15_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg[0] !== 'OK') return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* */ }
      msg[2] ? resolve() : reject(new Error(`relay rejected the delete: ${msg[3] ?? '?'}`));
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`cannot reach ${RELAY}`)); });
  });
}

// Paginate: the relay caps how many events one REQ returns, and a sweep can
// leave far more than that behind. Walk backwards through created_at until a
// round comes back empty.
// `includeTombstones` is for the post-delete verification only. A kind-5 is the
// deletion RECORD, not a cast, so counting it would report "1 test cast" forever
// after a successful purge and make the tool look like it had failed.
async function allTestCasts(includeTombstones = false) {
  const seen = new Map();
  let until;
  for (;;) {
    const filter = { authors: [TEST_PUBKEY], limit: 500, ...(until ? { until } : {}) };
    const batch = await query(filter);
    const fresh = batch.filter((e) => !seen.has(e.id));
    for (const e of batch) seen.set(e.id, e);
    if (fresh.length === 0) break;
    until = Math.min(...batch.map((e) => e.created_at)) - 1;
  }
  const all = [...seen.values()];
  return includeTombstones ? all : all.filter((e) => e.kind !== 5);
}

const events = await allTestCasts();
if (events.length === 0) {
  console.log(`No test casts on ${RELAY} (author ${TEST_PUBKEY.slice(0, 12)}…). Nothing to do.`);
  process.exit(0);
}

const byKind = events.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
console.log(`${events.length} test cast(s) on ${RELAY}:`);
for (const [kind, n] of Object.entries(byKind)) console.log(`   kind ${kind}: ${n}`);

if (DRY) {
  console.log('\n--dry-run: nothing deleted.');
  process.exit(0);
}

// One kind-5 naming every event. NIP-09 lets a single deletion carry many `e`
// tags, so this is one round trip rather than N.
const del = finalizeEvent({
  kind: 5,
  created_at: Math.floor(Date.now() / 1000),
  tags: events.map((e) => ['e', e.id]),
  content: 'purge test casts',
}, TEST_CAST_SECRET_KEY);

await publish(del);

// Verify rather than trust the ACK: a relay may accept a kind-5 and still serve
// the events (deletion support is optional in NIP-09).
const remaining = await allTestCasts();
if (remaining.length === 0) {
  console.log(`\nDeleted ${events.length} test cast(s).`);
} else {
  console.log(`\nRelay ACKed the deletion but still serves ${remaining.length} event(s).`);
  console.log('This relay does not honour NIP-09. Stop it and delete');
  console.log('tools/nostr-relay/data/nostr.db to reset the store instead.');
  process.exit(1);
}
