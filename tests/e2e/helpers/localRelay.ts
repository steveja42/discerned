// Publishes a signed cast to the LOCAL nostr relay (ws://localhost:7777) so the
// cast render can use the real subscribe path instead of a mocked WebSocket.
//
// Why this exists: page.routeWebSocket was the ONLY reason the cast had to render
// in a fresh, extension-free browser — the mock has to own the socket, and the
// extension's web-bridge competes for it. That cold browser has no history with
// bot-defended sites, so Akamai/Cloudflare 403 its image requests and the cast
// screenshot showed broken glyphs while the CLIP (rendered in the warm profile)
// showed the same images fine. Measured on ndtv: hero naturalWidth 0 in the cold
// browser vs 1010 in the warm one, same cast, same URL.
//
// Publishing to a real relay removes the mock, so the render can happen in the
// warm profile. It is also the more faithful test: the feed's real subscribe path
// runs, rather than a fabricated socket conversation.

import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import type { NostrEvent } from 'nostr-tools/core';

export const LOCAL_RELAY_URL = 'ws://localhost:7777';
const RELAY_PORT = 7777;

/** Is something already serving the relay port? */
export function relayIsUp(timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port: RELAY_PORT, host: '127.0.0.1' });
    const done = (up: boolean) => { sock.destroy(); resolve(up); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Ensure a relay is listening, starting one only if it is not.
 *
 * Returns whether THIS call started it. The caller must not stop a relay it did
 * not start: the developer normally keeps one running, and tearing it down at
 * the end of a test run would silently break their next capture. `run.ps1` is
 * itself idempotent (it exits cleanly when the port is taken), so the guard here
 * is belt-and-braces rather than the only protection.
 */
export async function ensureLocalRelay(): Promise<{ started: boolean }> {
  if (await relayIsUp()) return { started: false };
  spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', 'tools/nostr-relay/run.ps1', '-Yes'],
    { cwd: process.cwd(), stdio: 'ignore', timeout: 90_000 },
  );
  // The launcher backgrounds the relay, so poll rather than trusting the exit.
  for (let i = 0; i < 20; i++) {
    if (await relayIsUp()) return { started: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('local relay did not come up on ws://localhost:7777');
}

/**
 * Publish one signed event and resolve once the relay ACKs it.
 *
 * Waiting for the OK matters: the render opens `/discerns` immediately after, and
 * an event still in flight would leave the feed empty and the row wait timing out.
 */
export async function publishToLocalRelay(event: NostrEvent, timeoutMs = 10_000): Promise<void> {
  // Node's own global WebSocket (22+). The `ws` package is a transitive dep and
  // is NOT resolvable by bare specifier under pnpm's isolated store, so reaching
  // for it would mean hard-coding a store path that breaks on any version bump.
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(LOCAL_RELAY_URL);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closing */ }
      reject(new Error(`local relay did not ACK within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as unknown[];
        if (msg[0] !== 'OK') return;
        // ["OK", <id>, <accepted>, <reason>]
        if (msg[2] === true) return finish();
        finish(new Error(`relay rejected the event: ${String(msg[3] ?? 'no reason given')}`));
      } catch { /* ignore non-JSON frames */ }
    });
    ws.addEventListener('error', () => finish(new Error(`cannot reach ${LOCAL_RELAY_URL}`)));
  });
}
