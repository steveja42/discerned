#!/usr/bin/env node
// Zips the production build (`pnpm build` → `dist-pack/`) for public download.
//
// Public installs now come from the Chrome Web Store; this zip remains for
// side-loading (testers, a pre-store build) via "Load unpacked" in Chrome. It is
// still served from discerned-web/public/, just no longer linked from the site.
// `pnpm build` writes to `dist-pack/`, NOT the dev
// `dist/` that `pnpm dev` watches (see discerned-ext/CLAUDE.md) — both `pnpm
// build` and `pnpm pack:ext` share that one output dir on purpose, so packing
// never disturbs the loaded dev extension and there's only one production
// build to reason about. `dist-pack/` is kept after zipping so it can also be
// loaded unpacked locally.
//
// Zipping uses the OS-native tool (PowerShell Compress-Archive on Windows, `zip`
// elsewhere) so no extra npm dependency is needed.
//
// Output: discerned-web/public/discerned-extension.zip
//
// Run from discerned-ext/:  node scripts/pack-extension.mjs   (or `pnpm pack:ext`)

import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(__dirname, '..');
const buildDir = join(extRoot, 'dist-pack');
const outFile = resolve(extRoot, '..', 'discerned-web', 'public', 'discerned-extension.zip');

const version = JSON.parse(readFileSync(join(extRoot, 'manifest.json'), 'utf8')).version;

console.log(`pack-extension: building v${version} into ${buildDir} …`);

// pnpm.cmd must be launched through a shell on Windows.
const runOpts = { cwd: extRoot, stdio: 'inherit', shell: process.platform === 'win32' };
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build'], runOpts);

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
