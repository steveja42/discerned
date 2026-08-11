/// <reference types="vite/client" />

// Custom build-time flag — true in `pnpm dev` and `pnpm build:test`, replaced with
// false in production builds so Vite tree-shakes the dev/test hooks out of content.ts.
declare const __DISCERNED_DEV_BUILD__: boolean;
