// GoatCounter analytics helpers. All traffic is same-origin (Netlify reverse-proxies
// /api/stats/* → discernedweb.goatcounter.com) so hostname-based tracker blockers can't
// drop it. Cookieless, no PII, no cross-site tracking. See discerned-web/CLAUDE.md → Analytics.

import { LL, log } from '@/lib/logger';

/** Same-origin data endpoint. Netlify reverse-proxies /api/stats/count → discernedweb.goatcounter.com/count. */
export const GOATCOUNTER_ENDPOINT = '/api/stats/count';
/** Same-origin vendored counter script (public/api/stats/count.js) — avoids a gc.zgo.at hostname block. */
export const GOATCOUNTER_SCRIPT = '/api/stats/count.js';
/** Only report on the real production host — keeps localhost + Netlify deploy previews out of stats. */
export const PROD_HOST = 'discerned.online';

type GoatCounterCount = (opts: {
  path: string;
  title?: string;
  event?: boolean;
  referrer?: string;
}) => void;

declare global {
  interface Window {
    goatcounter?: { count?: GoatCounterCount };
  }
}

/** True only on the production host — the gate for injecting the script and sending any hit. */
export function isAnalyticsHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname === PROD_HOST;
}

/**
 * Fire an explicit GoatCounter event (e.g. an extension-ZIP download).
 * Null-safe: a no-op off-prod, or if the script was blocked / hasn't loaded yet.
 * Uses sendBeacon internally, so it never blocks or delays the triggering action.
 */
export function countEvent(path: string, title: string): void {
  if (!isAnalyticsHost()) return;
  const gc = window.goatcounter;
  if (!gc?.count) {
    log(LL.DEBUG, '[analytics] goatcounter not ready, skipping event:', path);
    return;
  }
  gc.count({ path, title, event: true });
}

/**
 * Record a pageview for an App Router (SPA) soft navigation. count.js only auto-counts
 * the initial hard load, so route changes must be reported manually. Null-safe / off-prod-safe.
 */
export function countPageview(path: string): void {
  if (!isAnalyticsHost()) return;
  window.goatcounter?.count?.({ path });
}
