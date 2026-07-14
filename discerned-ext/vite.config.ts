import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import manifest from './manifest.json';

// crxjs injects vendor/webcomponents-custom-elements.js with a sourceMappingURL
// pointing to a .map file that doesn't exist in dist/. Chrome DevTools rejects
// chrome-extension:// URLs for source map fetches anyway, so strip the reference.
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

export default defineConfig(({ mode }) => ({
  root: '.',
  server: {
    port: 5173,
    hmr: {
      port: 5173,
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
      },
    },
  },
  // Test-only message hooks in content.ts/background.ts are gated on this flag.
  // `pnpm build:test` runs with --mode test, which keeps them; `pnpm build`
  // (default production) replaces the flag with false and tree-shakes them out.
  define: {
    __DISCERNED_TEST_BUILD__: JSON.stringify(mode === 'test' || mode === 'development'),
  },
  plugins: [
    stripVendorSourcemapRefs,
    crx({ manifest }),
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