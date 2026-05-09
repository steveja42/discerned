// Role: Shared — console log bridge
// Description: Overrides console methods in every extension context. Content scripts/onboarding
//              run inside the page the VSCode debugger is attached to, so their console calls
//              are already visible there. Popup and Background forward their logs to the active
//              tab's content script via chrome.tabs.sendMessage (LOG_RELAY), so those calls
//              also surface in VSCode's single page-context debug session.
// Access: chrome.tabs (popup/background only), chrome.runtime (content/onboarding)

import type { AppLogLevel, LogLevel, LogSource } from './types';

/** Numeric log levels — higher number = more severe. */
export const LL = {
  TRACE:  0,
  DEBUG:  1,
  NORMAL: 2,
  WARN:   3,
  ERROR:  4,
} as const;

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

// Tab IDs that have registered as log relay targets, ordered most-recent first.
// Only the first entry receives logs — no duplicates. Background manages this
// list via setLogRelayTabs() and removes entries when tabs close.
let logRelayTabs: number[] = [];

export function setLogRelayTabs(tabs: number[]): void {
  logRelayTabs = tabs;
}

/** Forward a log call to the primary registered content script so it appears in VSCode. */
function forwardToActiveTab(source: LogSource, level: LogLevel, args: unknown[]): void {
  try {
    const payload = {
      type: 'LOG_RELAY' as const,
      source,
      level,
      serialized: args.map(serializeArg),
    };

    if (logRelayTabs.length > 0) {
      chrome.tabs.sendMessage(logRelayTabs[0], payload).catch(() => { /* tab gone — drop */ });
      return;
    }

    // Fallback before any content script has registered (e.g. on first SW startup).
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, payload).catch(() => { /* no content script — drop */ });
      }
    });
  } catch {
    // chrome.tabs unavailable in this context — silently drop.
  }
}

/** Detect the current extension context from available globals. */
function detectSource(): LogSource {
  // background service worker: no DOM, but has chrome.tabs
  if (typeof document === 'undefined') return 'background';
  // popup: has DOM and chrome.tabs
  if (typeof chrome !== 'undefined' && chrome.tabs) return 'popup';
  // content script / onboarding: has DOM, no chrome.tabs
  return 'content';
}

let bridgeInitialised = false;

/**
 * Override console methods for the current extension context (auto-detected).
 *
 * - 'content' / 'onboarding': run inside the page VSCode is attached to, so their
 *   console output is already visible. We add a [source] prefix for clarity and do
 *   nothing else.
 *
 * - 'popup' / 'background': NOT in the page context VSCode watches. We call the
 *   original locally (visible in the context's own DevTools) AND relay to the active
 *   tab via LOG_RELAY so VSCode captures them too.
 *
 * Called automatically on the first log() call — no manual init needed.
 */
function initLogBridge(): void {
  if (bridgeInitialised) return;
  bridgeInitialised = true;
  const source = detectSource();
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

/**
 * Minimum numeric level that will be emitted. Raise to suppress verbose output.
 * LL.TRACE=0, DEBUG=1, NORMAL=2, WARN=3, ERROR=4
 */
let activeLogLevel: AppLogLevel = LL.TRACE;

export function setLogLevel(level: AppLogLevel): void {
  activeLogLevel = level;
}

const CONSOLE_METHOD: Record<AppLogLevel, LogLevel> = {
  [LL.TRACE]:  'debug',
  [LL.DEBUG]:  'debug',
  [LL.NORMAL]: 'log',
  [LL.WARN]:   'warn',
  [LL.ERROR]:  'error',
};

/**
 * Structured logger for use throughout the extension.
 * Automatically initialises the log bridge on first call if not already done.
 * @param level - numeric level from LL (TRACE=0 … ERROR=4)
 */
export function log(level: AppLogLevel, ...args: unknown[]): void {
  if (!bridgeInitialised) initLogBridge();
  if (level < activeLogLevel) return;
  const method = CONSOLE_METHOD[level];
  (console[method] as (...a: unknown[]) => void)(...args);
}
