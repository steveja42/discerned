// Role: Background Service Worker — relay publisher
// Description: Wraps nostr-tools SimplePool to broadcast signed Nostr events to the effective
//              relay set. Requires minAcksFor(relays) successful ACKs within a 10-second timeout;
//              exposes health metrics so the background can surface publish failures.
// Access: WebSocket via nostr-tools/pool (the user's effective relay set — defaults ∪ their own
//         relays in production, a single ws://localhost relay in local mode; see
//         getEffectiveRelays in shared/relays.ts). chrome.storage.local via that helper. No DOM.

import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/core';
import { minAcksFor } from '@/shared/types';
import { getEffectiveRelays } from '@/shared/relays';
import { LL, log } from '@/shared/logger';

export interface PublishResult {
  relay: string;
  success: boolean;
  error?: string;
}

class RelayPool {
  private pool: SimplePool;
  private readonly PUBLISH_TIMEOUT = 10000; // 10 seconds

  constructor() {
    this.pool = new SimplePool();
  }

  /**
   * Resolve the effective relay set at call time (mode defaults ∪ the user's
   * own relays − removals). Read per-call, never cached, so a relay the user
   * adds or removes takes effect on the very next publish.
   */
  private async getActiveRelays(): Promise<string[]> {
    return getEffectiveRelays();
  }

  /**
   * Publish an event to all relays
   */
  async publish(event: NostrEvent): Promise<PublishResult[]> {
    const relayUrls = await this.getActiveRelays();
    log(LL.NORMAL, `Publishing to ${relayUrls.length} relay(s):`, relayUrls);

    const results = await Promise.allSettled(
      relayUrls.map(url => this.publishToRelay(url, event))
    );

    const publishResults: PublishResult[] = results.map((result, index) => {
      const url = relayUrls[index];
      
      if (result.status === 'fulfilled' && result.value) {
        return { relay: url, success: true };
      } else {
        const error = result.status === 'rejected' 
          ? result.reason?.message || 'Unknown error'
          : 'Publish failed';
        return { relay: url, success: false, error };
      }
    });

    return publishResults;
  }

  /**
   * Publish to a single relay with timeout
   */
  private async publishToRelay(url: string, event: NostrEvent): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Publish timeout: ${url}`));
      }, this.PUBLISH_TIMEOUT);

      try {
        // SimplePool.publish() returns Promise<string>[] — one promise per relay.
        // Awaiting the array itself resolves immediately (before the relay ACKs),
        // leaving the individual promises unhandled. Await the single relay's promise.
        const [relayPromise] = this.pool.publish([url], event);
        const reason = await relayPromise;

        // nostr-tools does NOT reject on a connection failure — instead it
        // RESOLVES the promise with a "connection failure: ..." string (see
        // SimplePool.publish in pool.js). A genuine relay ACK resolves with the
        // relay's OK reason, which is empty (or a benign note) on success. Treat
        // any resolved value that signals a failure as a rejection so a relay
        // that never accepted the event can't be miscounted as a success.
        if (typeof reason === 'string' && /^(connection failure|connection skipped|duplicate url)/i.test(reason)) {
          throw new Error(reason);
        }

        clearTimeout(timeout);
        log(LL.NORMAL, `Published to ${url}:`, event.id);
        resolve(true);
      } catch (error) {
        clearTimeout(timeout);
        log(LL.ERROR, `Failed to publish to ${url}:`, error);
        reject(error);
      }
    });
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    const relays = await this.getActiveRelays();
    this.pool.close(relays);
  }

  /**
   * Get connection status
   */
  async getStatus(): Promise<{ relays: string[] }> {
    return {
      relays: await this.getActiveRelays(),
    };
  }
}

// Singleton instance
export const relayPool = new RelayPool();

/**
 * Helper: Publish and wait for minimum successful publishes
 */
export async function publishWithMinimum(
  event: NostrEvent,
  minimumSuccess?: number
): Promise<{ success: boolean; results: PublishResult[] }> {
  const results = await relayPool.publish(event);
  const successCount = results.filter(r => r.success).length;
  // Derive the threshold from the relays actually attempted (1 for the lone
  // local relay, 2 for production) so a mid-publish mode toggle can't cause a
  // stale count mismatch. An explicit caller override still wins.
  const minimum = minimumSuccess ?? minAcksFor(results.map(r => r.relay));

  return {
    success: successCount >= minimum,
    results,
  };
}

/**
 * Helper: Get relay health status
 */
export function getRelayHealth(results: PublishResult[]): {
  healthy: number;
  total: number;
  percentage: number;
} {
  const healthy = results.filter(r => r.success).length;
  const total = results.length;
  const percentage = total > 0 ? (healthy / total) * 100 : 0;
  
  return { healthy, total, percentage };
}
