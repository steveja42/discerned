// Web-app logger. Mirrors the extension's logger API surface (LL levels,
// log(level, ...args), setLogLevel) so call sites read the same in both
// projects. The web app runs in a single page context so no cross-context
// bridge is needed.

/** Numeric log levels — higher number = more severe. */
export const LL = {
  TRACE:  0,
  DEBUG:  1,
  NORMAL: 2,
  WARN:   3,
  ERROR:  4,
} as const;

export type AppLogLevel = typeof LL[keyof typeof LL];

type ConsoleMethod = 'debug' | 'log' | 'warn' | 'error';

const CONSOLE_METHOD: Record<AppLogLevel, ConsoleMethod> = {
  [LL.TRACE]:  'debug',
  [LL.DEBUG]:  'debug',
  [LL.NORMAL]: 'log',
  [LL.WARN]:   'warn',
  [LL.ERROR]:  'error',
};

/**
 * Minimum numeric level that will be emitted. Raise to suppress verbose output.
 * LL.TRACE=0, DEBUG=1, NORMAL=2, WARN=3, ERROR=4
 */
let activeLogLevel: AppLogLevel = LL.DEBUG;

export function setLogLevel(level: AppLogLevel): void {
  activeLogLevel = level;
}

/**
 * Structured logger for use throughout the web app.
 * @param level - numeric level from LL (TRACE=0 … ERROR=4)
 */
export function log(level: AppLogLevel, ...args: unknown[]): void {
  if (level < activeLogLevel) return;
  const method = CONSOLE_METHOD[level];
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  (console[method] as (...a: unknown[]) => void)(`[web] ${ts}`, ...args);
}
