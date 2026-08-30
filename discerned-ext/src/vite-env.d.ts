/// <reference types="vite/client" />

// Custom build-time flag — true in `pnpm dev` and `pnpm build:test`, replaced with
// false in production builds so Vite tree-shakes the dev/test hooks out of content.ts.
declare const __DISCERNED_DEV_BUILD__: boolean;
// True only under `vite dev` (not `--mode test`, which is a real build).
declare const __DISCERNED_VITE_DEV__: boolean;
