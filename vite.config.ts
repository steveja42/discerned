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
    rollupOptions: {},
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