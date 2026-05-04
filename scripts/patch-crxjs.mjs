#!/usr/bin/env node
// Removes the console.warn from crxjs's MAIN-world content script loader template.
// crxjs hardcodes this warn in its source; it bypasses Vite's plugin pipeline so
// it can't be intercepted at build time. Re-run this after `pnpm install`.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, createRequire } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const pkgPath = require.resolve('@crxjs/vite-plugin');
const mjsPath = resolve(dirname(pkgPath), 'dist/index.mjs');

let src = readFileSync(mjsPath, 'utf8');

const bsQuote = String.fromCharCode(0x5c, 0x22); // \"
const bsN     = String.fromCharCode(0x5c, 0x6e); // \n

const warn = `console.warn(__SCRIPT__, ${bsQuote}Content-script doesn't support HMR because the world is MAIN${bsQuote});${bsN}    `;

if (!src.includes(warn)) {
  console.log('patch-crxjs: warn already absent, nothing to do.');
  process.exit(0);
}

src = src.replace(warn, '');
writeFileSync(mjsPath, src);
console.log('patch-crxjs: patched', mjsPath);
