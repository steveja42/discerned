// Identifies casts published by the e2e test suite / corpus sweep so the local-relay
// feed can filter them out by default. Every test cast (tests/e2e/helpers/castFromCapture.ts)
// is signed with ONE fixed key — literal, not random, so the events are identifiable and
// deletable (see tests/e2e/tools/purge-test-casts.mjs) instead of piling up as orphaned
// anonymous casts. This file derives that key's PUBLIC key only; the secret key itself is
// never needed here and never imported.
//
// The literal is duplicated (also in castFromCapture.ts and purge-test-casts.mjs) rather
// than imported — those live in the extension's test helpers and a standalone .mjs script,
// neither reachable from this package. If it ever changes, update all three.

import { getPublicKey } from 'nostr-tools/pure';

const TEST_CAST_SECRET_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff),
);

export const TEST_CAST_PUBKEY: string = getPublicKey(TEST_CAST_SECRET_KEY);
