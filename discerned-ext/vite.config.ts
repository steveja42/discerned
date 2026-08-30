import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import baseManifest from './manifest.json';

// Production ships no broad host permission: content scripts are injected per tab
// under activeTab, which only a real toolbar/context-menu click confers.
//
// Playwright cannot produce that click — activeTab grants and
// chrome.permissions.request() both require a TRUSTED gesture on browser chrome,
// which no automation API can synthesize. Without a host permission the test
// build therefore can't inject at all and every capture spec fails at step one.
//
// So dev/test builds declare <all_urls> outright. The divergence is deliberately
// limited to WHERE the host grant comes from: the injection code the specs
// exercise (injectDiscerned, its ordering, the idempotency guards, the built-file
// paths) is byte-identical to production. activeTab itself is the one part no
// spec can cover — verify it by hand against a dist-pack build.
function manifestFor(mode: string) {
  const isDev = mode === 'development';
  if (!isDev) return baseManifest;

  // DEV ONLY — and this does NOT change how the extension behaves.
  //
  // crxjs builds (and HMR-serves) exactly what the manifest declares. Our two
  // injected scripts deliberately are not content_scripts, so in dev they were
  // never emitted, and hand-writing a loader that imports them over http from
  // the dev server fails two ways: the MAIN-world script has no chrome.runtime,
  // and the served module's root-absolute imports (/src/...) resolve against the
  // PAGE's origin, not the extension's.
  //
  // So declare them here with a match pattern that can never fire. crxjs then
  // emits its own loader + transformed module pair (with imports rewritten to
  // the extension origin, HMR intact), Chrome never auto-injects them, and
  // background.ts injects that loader on the gesture exactly as in production.
  const NEVER = 'https://dev-null.invalid/*';
  return {
    ...baseManifest,
    content_scripts: [
      ...(baseManifest.content_scripts ?? []),
      { matches: [NEVER], js: ['src/content/nip07-bridge.ts'], run_at: 'document_idle', world: 'MAIN' },
      { matches: [NEVER], js: ['src/content/content.ts'], run_at: 'document_idle', all_frames: false },
    ],
  };
}


// crxjs injects vendor/webcomponents-custom-elements.js with a sourceMappingURL
// pointing to a .map file that doesn't exist in dist/. Chrome DevTools rejects
// chrome-extension:// URLs for source map fetches anyway, so strip the reference.
// The two scripts injected at runtime via chrome.scripting (not declared in
// content_scripts). Names are fixed so background.ts can reference them.
const INJECTED_ENTRIES = [
  { name: 'injected-content', file: 'src/content/content.ts' },
  { name: 'injected-nip07-bridge', file: 'src/content/nip07-bridge.ts' },
];

const stripVendorSourcemapRefs: Plugin = {
  name: 'strip-vendor-sourcemap-refs',
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'asset' && file.fileName.startsWith('vendor/') && typeof file.source === 'string') {
        file.source = file.source.replace(/\n?\/\/# sourceMappingURL=\S+/g, '');
      }
    }
  },
};

// content.ts / nip07-bridge.ts are injected at runtime (chrome.scripting) rather
// than declared in content_scripts, so crxjs never emits them. They also can't be
// ordinary rollup entries here: executeScript runs files as CLASSIC scripts, and
// a code-split ES entry throws "Cannot use import statement outside a module" and
// silently never runs. So they're built as self-contained IIFEs by a second Vite
// pass, chained here so `pnpm dev` / `--watch` keep dist/ complete — without this
// the loaded dev extension loses its content script with no visible error.
function buildInjectedScripts(mode: string): Plugin {
  let outDir = 'dist';
  let running = false;
  return {
    name: 'build-injected-scripts',
    // No `apply` — this must run for BOTH `vite build` and `vite dev`. The two
    // paths produce different content (see below) but the same filenames, so the
    // background's executeScript target is identical everywhere.
    configResolved(cfg) { outDir = cfg.build.outDir || 'dist'; },

    // Dev server: emit a classic-script LOADER for each injected entry, shaped
    // like the one crxjs generates for a declared content script. executeScript
    // needs a classic script, but the loader's dynamic import pulls the real
    // module from the Vite dev server — so the content script keeps full HMR and
    // dev behaves like production (same gesture injection, same files).
    //
    // This works because Vite transforms any source path on request (verified:
    // /src/content/content.ts returns 200 even though it is no longer a declared
    // content script), and crxjs's dev manifest exposes `**\/*` as
    // web-accessible so chrome.runtime.getURL can reach the vite client.
    // No configureServer hook: under `vite dev` the two scripts are declared in
    // the manifest with an unreachable match (see manifestFor), so crxjs builds
    // and HMR-serves them and emits its own loaders at
    // src/content/<name>.ts-loader.js. background.ts targets those directly via
    // __DISCERNED_VITE_DEV__. Chrome never auto-injects them (the match cannot
    // fire), so activation still goes through the same gesture path as
    // production — dev and prod share one mechanism.

    // Production / test builds: a real self-contained IIFE bundle.
    async closeBundle() {
      if (running) return; // the nested build re-enters this hook
      running = true;
      try {
        const { buildInjected } = await import('./scripts/build-injected.mjs');
        await buildInjected({ outDir: resolve(__dirname, outDir), mode });
      } finally {
        running = false;
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: '.',
  // Default '/' emits root-absolute asset URLs (/assets/...). For an MV3 extension
  // page nested under src/onboarding/, Chrome's loader treats a root-absolute
  // modulepreload href as a cross-world resource mismatch and refuses to use it,
  // stalling the page load (script src is unaffected — crx patches that path
  // separately). Empty base makes Vite/crx emit chrome-extension://<id>-relative
  // URLs instead.
  base: '',
  server: {
    port: 5173,
    hmr: {
      port: 5173,
    },
    // Vite 5.4.12+ hardened the dev server's CORS to same-origin only (CVE
    // fix). crxjs dev mode loads the service worker and HMR client FROM the
    // extension origin, so without this the SW fails to register with
    // "status code: 3" and a CORS error on /@vite/env. Allow chrome-extension://
    // (and the moz- equivalent) explicitly; this is dev-only and never ships.
    cors: {
      origin: [/^chrome-extension:\/\//, /^moz-extension:\/\//, /^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/],
      credentials: true,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: mode === 'production' ? 'terser' : false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      // Register standalone pages as HTML entries so crxjs bundles their <script>
      // and rewrites ./*.ts → the emitted .js. crxjs auto-discovers HTML the manifest
      // points at (default_popup, options_ui) but NOT web_accessible_resources-only
      // pages, so without this the raw ./onboarding.ts 404s and the page's JS never runs.
      input: {
        onboarding: resolve(__dirname, 'src/onboarding/onboarding.html'),
        popup: resolve(__dirname, 'src/popup/popup.html'),
        permissions: resolve(__dirname, 'src/permissions/permissions.html'),
      },
    },
  },
  // Dev/test-only hooks (test message bridges, verbose logging) are gated on this
  // flag. `pnpm dev` (--mode development) and `pnpm build:test` (--mode test) keep
  // them; `pnpm build` / `pnpm pack:ext` (default production) replace the flag with
  // false and tree-shake them out.
  define: {
    __DISCERNED_DEV_BUILD__: JSON.stringify(mode === 'test' || mode === 'development'),
    // True ONLY under `vite dev`. Dev injects crxjs's HMR loaders; build/test
    // inject the self-contained IIFEs. Separate from __DISCERNED_DEV_BUILD__,
    // which is also true for `--mode test` (a real build).
    __DISCERNED_VITE_DEV__: JSON.stringify(mode === 'development'),
  },
  plugins: [
    stripVendorSourcemapRefs,
    crx({ manifest: manifestFor(mode) }),
    buildInjectedScripts(mode),
    viteStaticCopy({
      targets: [
        { src: 'public/icons', dest: '.' },
      ],
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
}));