// Role: Shared — NIP-44 encryption utilities
// Description: Encrypts and decrypts private clip payloads (JSON) using NIP-44 (ChaCha20-Poly1305).
//              Conversation key derivation is exposed for self-encryption. Full implementation
//              is partial (Phase 1 stub); kind 30078 storage is planned for Phase 2.
// Access: nostr-tools/nip44 (encrypt, decrypt, getConversationKey)

import * as nip44 from 'nostr-tools/nip44';
import type { CaptureResult, Evaluation } from '@/shared/types';

export interface EncryptedClipPayload {
  capture: CaptureResult;
  evaluation: Evaluation;
  timestamp: number;
}

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

  const p = payload as any;

  // Check capture
  if (!p.capture || typeof p.capture !== 'object') {
    return false;
  }

  if (!['quote', 'resource'].includes(p.capture.type)) {
    return false;
  }

  // Check evaluation
  if (!p.evaluation || typeof p.evaluation !== 'object') {
    return false;
  }

  if (!p.evaluation.interest || !p.evaluation.ethics || !p.evaluation.category) {
    return false;
  }

  // Check timestamp
  if (!Number.isInteger(p.timestamp) || p.timestamp < 0) {
    return false;
  }

  return true;
}

/**
 * Prepare payload for encryption
 */
export function prepareClipPayload(
  capture: CaptureResult,
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
    console.error('Encryption failed:', error);
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
    console.error('Decryption failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown decryption error',
    };
  }
}
