// Role: Background Service Worker — relay publisher
// Description: Wraps nostr-tools SimplePool to broadcast signed Nostr events to the ACTIVE_RELAYS
//              set. Requires MIN_PUBLISH_ACKS successful ACKs within a 10-second timeout; exposes
//              health metrics so the background can surface publish failures.
// Access: WebSocket via nostr-tools/pool (wss:// in production; a single ws://localhost relay in
//         dev/test builds — see ACTIVE_RELAYS in shared/types.ts). No DOM, no Chrome APIs.

import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/core';
import { ACTIVE_RELAYS, MIN_PUBLISH_ACKS } from '@/shared/types';
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
   * Publish an event to all relays
   */
  async publish(event: NostrEvent): Promise<PublishResult[]> {
    const relayUrls = Array.from(ACTIVE_RELAYS);
    
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
        await relayPromise;

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
    this.pool.close(Array.from(ACTIVE_RELAYS));
  }

  /**
   * Get connection status
   */
  getStatus(): { relays: string[] } {
    return {
      relays: Array.from(ACTIVE_RELAYS),
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
  minimumSuccess: number = MIN_PUBLISH_ACKS
): Promise<{ success: boolean; results: PublishResult[] }> {
  const results = await relayPool.publish(event);
  const successCount = results.filter(r => r.success).length;
  
  return {
    success: successCount >= minimumSuccess,
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
