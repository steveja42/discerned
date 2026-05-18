// Role: Shared — NIP-46 remote signer (bunker) lifecycle management
// Description: Manages a BunkerSigner instance in the service worker context.
//              Service workers are killed after ~30s of inactivity, so the WebSocket
//              connection held by BunkerSigner dies. This module reconnects on demand.
// Access: background worker only

import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import type { BunkerPointer } from 'nostr-tools/nip46';
import { generateSecretKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

// Module-level signer survives within a single SW lifetime, reset on next wake
let activeSigner: BunkerSigner | null = null;

/**
 * Connect to a bunker:// URI for the first time.
 * Generates a new ephemeral client keypair, connects, retrieves the user's pubkey.
 * Returns connection data to be persisted in chrome.storage.local.
 */
export async function connectFromBunkerUri(uri: string): Promise<{
  pubkey: string;
  bunkerRelays: string[];
  remotePubkey: string;
  clientKeyHex: string;
}> {
  const bp = await parseBunkerInput(uri);
  if (!bp) throw new Error('Invalid connection link. Please check and try again.');

  const clientKey = generateSecretKey();
  const signer = BunkerSigner.fromBunker(clientKey, bp);
  await signer.connect();
  const pubkey = await signer.getPublicKey();

  activeSigner = signer;

  return {
    pubkey,
    bunkerRelays: bp.relays,
    remotePubkey: bp.pubkey,
    clientKeyHex: bytesToHex(clientKey),
  };
}

/**
 * Get the active signer or reconnect using stored connection data.
 * Called on every signing request since the SW may have been killed between uses.
 */
export async function getOrCreateBunkerSigner(
  clientKeyHex: string,
  bp: BunkerPointer,
): Promise<BunkerSigner> {
  if (activeSigner) return activeSigner;

  const signer = BunkerSigner.fromBunker(hexToBytes(clientKeyHex), bp);
  await signer.connect();
  activeSigner = signer;
  return signer;
}

/**
 * Close and discard the active signer. Called on disconnect.
 */
export function invalidateBunkerSigner(): void {
  activeSigner?.close();
  activeSigner = null;
}
