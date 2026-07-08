#!/usr/bin/env node
// Builds a clean production copy of the extension and zips it for public download.
//
// The zip is what the web app's /get-extension page hands users so they can
// "Load unpacked" in Chrome. We build into `dist-pack/` (NOT the dev `dist/`
// that `pnpm dev` watches — see discerned-ext/CLAUDE.md) and zip that, so
// packing never disturbs the loaded dev extension. `dist-pack/` is kept after
// zipping so it can be loaded unpacked locally.
//
// Zipping uses the OS-native tool (PowerShell Compress-Archive on Windows, `zip`
// elsewhere) so no extra npm dependency is needed.
//
// Output: discerned-web/public/discerned-extension.zip
//
// Run from discerned-ext/:  node scripts/pack-extension.mjs   (or `pnpm pack:ext`)

import { execFileSync } from 'child_process';
import { rmSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(__dirname, '..');
const buildDir = join(extRoot, 'dist-pack');
const outFile = resolve(extRoot, '..', 'discerned-web', 'public', 'discerned-extension.zip');

const version = JSON.parse(readFileSync(join(extRoot, 'manifest.json'), 'utf8')).version;

console.log(`pack-extension: building v${version} into ${buildDir} …`);

// Fresh production build into an isolated dir so we never touch dev `dist/`.
rmSync(buildDir, { recursive: true, force: true });
// .cmd shims (tsc.cmd, vite.cmd) must be launched through a shell on Windows.
const bin = (name) =>
  join(extRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const runOpts = { cwd: extRoot, stdio: 'inherit', shell: process.platform === 'win32' };
execFileSync(bin('tsc'), [], runOpts);
execFileSync(bin('vite'), ['build', '--outDir', 'dist-pack', '--emptyOutDir'], runOpts);

mkdirSync(dirname(outFile), { recursive: true });
rmSync(outFile, { force: true });

if (process.platform === 'win32') {
  // Compress-Archive with dir/* keeps the extension files at the zip root, so
  // users select the unzipped folder directly in chrome://extensions.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(buildDir, '*')}' -DestinationPath '${outFile}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-r', '-9', outFile, '.'], { cwd: buildDir, stdio: 'inherit' });
}

console.log(`pack-extension: wrote ${outFile}`);
console.log(`pack-extension: production build kept at ${buildDir} (load it unpacked from there)`);
