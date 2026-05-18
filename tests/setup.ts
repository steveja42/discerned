// Vitest setup for the discerned-ext jsdom suite. Provides global shims for the
// chrome.* APIs that capture.ts and friends call into, so the extractors can be
// driven against fixture HTML without launching a real browser.

import { afterEach, vi } from 'vitest';
import { setLogLevel, LL } from '@/shared/logger';

// Quiet the extension's own logger during test runs — only warnings and errors
// surface. Without this, every capture prints its sanitized HTML body, which
// drowns the test summary in noise.
setLogLevel(LL.WARN);

// Silence jsdom's "Error: Not implemented: window.alert" noise. The XSS fixture
// contains a literal <script>alert(1)</script> that jsdom tries to execute
// before the sanitizer runs; the warning is informational, not a failure.
const _origConsoleError = console.error;
console.error = (...args: unknown[]): void => {
  const first = args[0];
  if (first instanceof Error && /Not implemented:\s*window\./.test(first.message)) return;
  if (typeof first === 'string' && /Not implemented:\s*window\./.test(first)) return;
  _origConsoleError(...args);
};

// 1x1 transparent PNG — returned by the INLINE_IMAGE mock so isSafeImageSrc
// accepts the result (data:image/png;...).
const TRANSPARENT_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface BackgroundResponseOk<T = unknown> {
  success: true;
  data?: T;
}

const sendMessage = vi.fn(async (msg: unknown): Promise<BackgroundResponseOk> => {
  const m = msg as { type?: string };
  if (m?.type === 'INLINE_IMAGE') {
    return { success: true, data: { dataUri: TRANSPARENT_PNG_DATA_URI } };
  }
  return { success: true };
});

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage,
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false),
    },
    onInstalled: { addListener: vi.fn() },
    lastError: undefined,
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  },
  tabs: {
    sendMessage: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
  },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
};

// Older jsdom lacks DOMParser inheritance for some methods; ensure global.
if (typeof globalThis.DOMParser === 'undefined') {
  // jsdom 24 provides it, but guard for safety.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.DOMParser = require('jsdom').JSDOM.window.DOMParser;
}

afterEach(() => {
  vi.clearAllMocks();
});

export { TRANSPARENT_PNG_DATA_URI };
