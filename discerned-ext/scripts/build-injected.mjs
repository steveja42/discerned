// Build the two on-demand-injected content scripts as SELF-CONTAINED classic
// scripts (IIFE), one file each, into an existing build output dir.
//
// Why a separate pass: these two are not declared in the manifest's
// content_scripts (production ships no broad host permission — they're injected
// per tab under activeTab from the toolbar/context-menu gesture), so crxjs never
// sees them and the main build won't emit them at all. Adding them as extra
// rollup inputs there DOES emit them, but as ES modules that `import` the shared
// chunks — and chrome.scripting.executeScript runs files as CLASSIC scripts, so
// the first import throws "Cannot use import statement outside a module" and the
// script silently never runs. IIFE format with no code splitting is the fix.
//
// Run after the main vite build, against the same outDir.

import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const ENTRIES = [
  { name: 'injected-content', file: 'src/content/content.ts' },
  { name: 'injected-nip07-bridge', file: 'src/content/nip07-bridge.ts' },
];

export async function buildInjected({ outDir, mode }) {
  for (const entry of ENTRIES) {
    await build({
      root,
      configFile: false,
      resolve: {
        alias: { '@': resolve(root, 'src') },
      },
      define: {
        __DISCERNED_DEV_BUILD__: JSON.stringify(mode === 'test' || mode === 'development'),
      },
      build: {
        outDir,
        emptyOutDir: false, // the main build already populated this dir
        minify: mode === 'production' ? 'terser' : false,
        sourcemap: mode !== 'production',
        lib: {
          entry: resolve(root, entry.file),
          formats: ['iife'],
          name: entry.name.replace(/-/g, '_'),
          fileName: () => `${entry.name}.js`,
        },
      },
      logLevel: 'warn',
    });
  }
}

// CLI: node scripts/build-injected.mjs <outDir> <mode>
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
    || process.argv[1].endsWith('build-injected.mjs')) {
  const outDir = process.argv[2] ?? 'dist';
  const mode = process.argv[3] ?? 'production';
  await buildInjected({ outDir: resolve(root, outDir), mode });
  // eslint-disable-next-line no-console
  console.log(`✓ injected scripts → ${outDir}/ (mode=${mode})`);
}
