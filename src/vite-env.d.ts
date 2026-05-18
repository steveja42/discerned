/// <reference types="vite/client" />

// Custom build-time flag — true in `pnpm build:test`, replaced with false in
// production builds so Vite tree-shakes the test hooks out of content.ts.
declare const __DISCERNED_TEST_BUILD__: boolean;
