// Role: Shared — console log bridge
// Description: Overrides console methods in every extension context. Content scripts/onboarding
//              run inside the page the VSCode debugger is attached to, so their console calls
//              are already visible there. Popup and Background forward their logs to the active
//              tab's content script via chrome.tabs.sendMessage (LOG_RELAY), so those calls
//              also surface in VSCode's single page-context debug session.
// Access: chrome.tabs (popup/background only), chrome.runtime (content/onboarding)

import type { LogLevel, LogSource } from './types';

/**
 * REMOTE_LOGGING toggle
 * ─────────────────────
 * true  → logs from popup/background are relayed to the active tab so VSCode sees them
 * false → bridge is a no-op; only local console calls fire (set before publishing to Web Store)
 */
const REMOTE_LOGGING = true;

const LEVELS: LogLevel[] = ['log', 'warn', 'error', 'info', 'debug'];

// Captured before any override — used by relayLog() to bypass the overridden console
// and avoid double-prefixing when re-emitting incoming LOG_RELAY messages.
const originals = {} as Record<LogLevel, (...args: unknown[]) => void>;

/** Safely convert an arbitrary value to a plain string for cross-context transport. */
function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ? `[Error] ${arg.stack}` : `[Error] ${arg.message}`;
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/** Forward a log call to the active tab's content script so it appears in VSCode. */
function forwardToActiveTab(source: LogSource, level: LogLevel, args: unknown[]): void {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId === undefined) return;
      chrome.tabs.sendMessage(tabId, {
        type: 'LOG_RELAY',
        source,
        level,
        serialized: args.map(serializeArg),
      }).catch(() => {
        // Content script not present on this tab (e.g. chrome:// page) — silently drop.
      });
    });
  } catch {
    // chrome.tabs unavailable in this context — silently drop.
  }
}

/**
 * Override console methods for the given extension context.
 *
 * - 'content' / 'onboarding': run inside the page VSCode is attached to, so their
 *   console output is already visible. We add a [source] prefix for clarity and do
 *   nothing else.
 *
 * - 'popup' / 'background': NOT in the page context VSCode watches. We call the
 *   original locally (visible in the context's own DevTools) AND relay to the active
 *   tab via LOG_RELAY so VSCode captures them too.
 *
 * Call once at the very top of each entry point. No-op when REMOTE_LOGGING is false.
 */
export function initLogBridge(source: LogSource): void {
  const c = console as unknown as Record<LogLevel, (...args: unknown[]) => void>;

  for (const level of LEVELS) {
    originals[level] = c[level].bind(console); // snapshot before any override

    if (!REMOTE_LOGGING) continue; // keep originals captured, skip the override

    if (source === 'content' || source === 'onboarding') {
      // Already in the page context VSCode watches — just prefix for visual clarity.
      const orig = originals[level];
      c[level] = (...args: unknown[]) => orig(`[${source}]`, ...args);
    } else {
      // popup / background: relay to the active tab so VSCode's debug session sees it.
      const orig = originals[level];
      c[level] = (...args: unknown[]) => {
        orig(...args);                          // local output (context's own DevTools)
        forwardToActiveTab(source, level, args);
      };
    }
  }
}

/**
 * Re-emit a relayed log using the pre-override original console methods.
 * Called by the content script's LOG_RELAY message handler so relayed entries
 * bypass the [content] override and don't pick up a double prefix.
 */
export function relayLog(level: LogLevel, source: LogSource, serialized: string[]): void {
  const fn = originals[level] ?? (console[level] as (...args: unknown[]) => void).bind(console);
  fn(`[${source}]`, ...serialized);
}
