// Role: Shared — NIP-44 encryption utilities
// Description: Encrypts and decrypts private clip payloads (JSON) using NIP-44 (ChaCha20-Poly1305).
//              Conversation key derivation is exposed for self-encryption. Full implementation
//              is partial (Phase 1 stub); kind 30078 storage is planned for Phase 2.
// Access: nostr-tools/nip44 (encrypt, decrypt, getConversationKey)

import * as nip44 from 'nostr-tools/nip44';
import type { Capture, Evaluation } from '@/shared/types';
import { LL, log } from '@/shared/logger';

export interface EncryptedClipPayload {
  capture: Capture;
  evaluation: Evaluation;
  timestamp: number;
}

const VALID_FORMATS = new Set([
  'selection',
  'article',
  'full-page',
  'bookmark',
]);

/**
 * Encrypt a clip payload using NIP-44
 * For self-encryption, conversationKey should be derived from own keys
 */
export function encryptClip(
  payload: EncryptedClipPayload,
  conversationKey: Uint8Array
): string {
  const json = JSON.stringify(payload);
  return nip44.encrypt(json, conversationKey);
}

/**
 * Decrypt a clip payload using NIP-44
 */
export function decryptClip(
  encrypted: string,
  conversationKey: Uint8Array
): EncryptedClipPayload {
  const json = nip44.decrypt(encrypted, conversationKey);
  return JSON.parse(json);
}

/**
 * Generate a conversation key for self-encryption
 * This is used when encrypting clips to yourself
 */
export function getConversationKey(
  privateKey: Uint8Array,
  publicKey: string
): Uint8Array {
  return nip44.getConversationKey(privateKey, publicKey);
}

/**
 * Validate encrypted payload structure
 */
export function validateEncryptedPayload(payload: unknown): payload is EncryptedClipPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const p = payload as { capture?: unknown; evaluation?: unknown; timestamp?: unknown };

  if (!p.capture || typeof p.capture !== 'object') {
    return false;
  }

  const cap = p.capture as { format?: unknown };
  if (typeof cap.format !== 'string' || !VALID_FORMATS.has(cap.format)) {
    return false;
  }

  if (!p.evaluation || typeof p.evaluation !== 'object') {
    return false;
  }
  const ev = p.evaluation as { interest?: unknown; ethics?: unknown; category?: unknown };
  if (!ev.interest || !ev.ethics || !ev.category) {
    return false;
  }

  if (!Number.isInteger(p.timestamp) || (p.timestamp as number) < 0) {
    return false;
  }

  return true;
}

/**
 * Prepare payload for encryption
 */
export function prepareClipPayload(
  capture: Capture,
  evaluation: Evaluation
): EncryptedClipPayload {
  return {
    capture,
    evaluation,
    timestamp: Date.now(),
  };
}

/**
 * Error handling for encryption/decryption
 */
export class EncryptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * Safe encryption with error handling
 */
export function safeEncrypt(
  payload: EncryptedClipPayload,
  conversationKey: Uint8Array
): { success: true; encrypted: string } | { success: false; error: string } {
  try {
    const encrypted = encryptClip(payload, conversationKey);
    return { success: true, encrypted };
  } catch (error) {
    log(LL.ERROR, 'Encryption failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown encryption error',
    };
  }
}

/**
 * Safe decryption with error handling
 */
export function safeDecrypt(
  encrypted: string,
  conversationKey: Uint8Array
): { success: true; payload: EncryptedClipPayload } | { success: false; error: string } {
  try {
    const payload = decryptClip(encrypted, conversationKey);

    if (!validateEncryptedPayload(payload)) {
      return { success: false, error: 'Invalid payload structure' };
    }

    return { success: true, payload };
  } catch (error) {
    log(LL.ERROR, 'Decryption failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown decryption error',
    };
  }
}
