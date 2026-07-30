// Regenerates every shipped icon raster from the two master SVGs.
//
// Run:  pnpm gen:icons          (from discerned-ext/)
//
// The rasters are COMMITTED BUILD-TIME ASSETS, not generated at build or runtime.
// The extension manifest and Next's file-convention icon lookup both need real files
// on disk, and the art changes about once a year — so a build-step dependency would
// buy nothing and cost a rasteriser in the critical path. Same rationale as
// discerned-web/scripts/gen-lightning-qr.mjs; read that file's header for the pattern.
//
// This script writes into BOTH sub-projects on purpose. The two masters diverge (see
// below) and hand-copying between them is exactly what would let them drift.
//
// ── The theme split ───────────────────────────────────────────────────────────────
//   DARK  (discerned-ext/art/icon.svg, azure #60a5fa on #0a0a0b)
//     → the extension's toolbar / extensions-page / Web Store icons, and the mirrored
//       copies in discerned-web/public/icons/ that .well-known/nostr.json points at
//       for the Nostr profile avatar (Nostr clients are overwhelmingly dark-themed).
//   CREAM (discerned-web/app/icon.svg, navy #1d4ed8 on #f6f1e8)
//     → the site's own favicon.ico + apple-icon.png, matching its light paper theme
//       and the navbar .brand-mark's var(--accent-ink).
//
//   discerned-web/public/icons/* is therefore NO LONGER a byte-mirror of the
//   extension's icons. That divergence is intentional — don't "fix" it.
//
// ── Why Chromium, why Pillow ──────────────────────────────────────────────────────
// Rasterising uses @playwright/test's bundled Chromium (already a root devDependency
// for the e2e suite — no new package). It renders the SVG with the very engine that
// will draw the navbar mark, so the icon can't disagree with the live page. `sharp`
// looks available but is NOT resolvable here: it appears only in a pnpm
// `onlyBuiltDependencies` allowlist, not as a real dependency.
//
// Chromium cannot emit .ico, so Pillow (installed system-wide, verified) packs the
// multi-size favicon from the PNGs Chromium produced. Pillow never parses SVG.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..');
const webRoot = resolve(extRoot, '..', 'discerned-web');

// The dark masters live in art/, NOT public/icons/. Vite's publicDir defaults to
// `public/`, so anything under it is copied verbatim into every build — an SVG left
// beside the PNGs would ship inside the extension users download for no reason.
const DARK_SVG = join(extRoot, 'art', 'icon.svg');
const CREAM_SVG = join(webRoot, 'app', 'icon.svg');

// The 16px frame gets its own simplified drawing — a downscale of the full mark is an
// unreadable smudge (~4px wide, rays and rungs gone). See either small master's header.
const DARK_SMALL_SVG = join(extRoot, 'art', 'icon-small.svg');
// Cream small master sits in art/ too: under app/ it would be one `-small` away from
// Next's `icon.*` file convention, and a stray second site icon is easy to create.
const CREAM_SMALL_SVG = join(webRoot, 'art', 'icon-small.svg');
const SMALL_AT = 16;

/** The master to draw `size` from: the small variant only at 16px. */
const masterFor = (size, full, small) => (size <= SMALL_AT ? small : full);

// Render at 8x then downsample with Lanczos. Chromium's own downscale to 16px turns
// the tower's 0.9-unit rungs into mush; supersampling keeps them as distinct lines.
const SUPERSAMPLE = 8;

/**
 * Rasterise an SVG file to a PNG buffer at `size`x`size`.
 * Renders at SUPERSAMPLE x, then Lanczos-downsamples via Pillow.
 */
async function render(page, svgPath, size) {
  const svg = readFileSync(svgPath, 'utf8');
  const big = size * SUPERSAMPLE;

  // Inline the SVG at the supersampled size. `background: transparent` keeps the
  // master's own rounded-rect the only background — a page background would square
  // off the corners.
  await page.setViewportSize({ width: big, height: big });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">
       <div id="w" style="width:${big}px;height:${big}px">${svg}</div>
     </body></html>`,
    { waitUntil: 'load' },
  );
  await page.$eval(
    '#w > svg',
    (el, n) => { el.setAttribute('width', String(n)); el.setAttribute('height', String(n)); },
    big,
  );

  const shot = await page.locator('#w').screenshot({ omitBackground: true });
  return downsample(shot, size);
}

/** Lanczos-downsample a PNG buffer to `size`x`size` via Pillow. */
function downsample(pngBuffer, size) {
  const inFile = join(stage, 'in.png');
  const outFile = join(stage, 'out.png');
  writeFileSync(inFile, pngBuffer);
  py(`
from PIL import Image
im = Image.open(r"${inFile}").convert("RGBA")
im.resize((${size}, ${size}), Image.LANCZOS).save(r"${outFile}")
`);
  return readFileSync(outFile);
}

/** Run an inline Python script, surfacing its stderr on failure. */
function py(code) {
  const f = join(stage, 'run.py');
  writeFileSync(f, code, 'utf8');
  execFileSync(PYTHON, [f], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const stage = join(tmpdir(), 'discerned-icongen');
mkdirSync(stage, { recursive: true });

// `python` on Windows, `python3` most places. Pillow lives on whichever answers.
const PYTHON = (() => {
  for (const bin of ['python', 'python3']) {
    try {
      execFileSync(bin, ['-c', 'import PIL'], { stdio: 'ignore' });
      return bin;
    } catch { /* try the next one */ }
  }
  throw new Error('Need Python with Pillow installed (pip install pillow) to pack the .ico.');
})();

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

const write = (path, buf) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`  ${path.replace(resolve(extRoot, '..'), '.')}  (${buf.length.toLocaleString()} B)`);
};

// ── DARK → extension icons + the web mirror that serves the Nostr avatar ──────────
console.log('Rendering dark master (extension + Nostr avatar)…');
const extPngs = [];
for (const size of [16, 48, 128]) {
  const png = await render(page, masterFor(size, DARK_SVG, DARK_SMALL_SVG), size);
  write(join(extRoot, 'public', 'icons', `icon${size}.png`), png);
  write(join(webRoot, 'public', 'icons', `icon${size}.png`), png);
  extPngs.push([`icon${size}.png`, png]);
}
// No icon.svg is written beside those PNGs. The masters live in art/ on both sides —
// a served public/ directory is not the place for build-time art sources.

// Push the new PNGs into any build dir that already exists.
//
// `viteStaticCopy` copies public/icons ONCE at watcher startup and does not watch it,
// so editing an icon leaves a running `pnpm dev` serving the OLD one indefinitely —
// the loaded extension keeps showing the previous art with no sign anything is stale,
// and `pnpm build` is not an option here (it would clobber the dev dist/, see
// CLAUDE.md → Dev environment). Copying directly is the fix. Also clears any icon.svg
// a pre-art/ build left behind.
for (const dir of ['dist', 'dist-test', 'dist-pack']) {
  const iconsDir = join(extRoot, dir, 'icons');
  if (!existsSync(iconsDir)) continue;
  for (const [name, png] of extPngs) writeFileSync(join(iconsDir, name), png);
  for (const stray of ['icon.svg', 'icon-small.svg']) rmSync(join(iconsDir, stray), { force: true });
  console.log(`  refreshed ${dir}/icons/`);
}

// ── CREAM → the site's own favicon + apple-touch icon ─────────────────────────────
console.log('Rendering cream master (site favicon)…');
write(join(webRoot, 'app', 'apple-icon.png'), await render(page, CREAM_SVG, 180));

// favicon.ico packs 16/32/48/256 — matching the sizes the previous icon shipped.
const icoSizes = [16, 32, 48, 256];
const icoParts = [];
for (const size of icoSizes) {
  const f = join(stage, `ico-${size}.png`);
  writeFileSync(f, await render(page, masterFor(size, CREAM_SVG, CREAM_SMALL_SVG), size));
  icoParts.push(f);
}
const icoOut = join(webRoot, 'app', 'favicon.ico');
// Pillow's append_images + sizes= writes a genuine multi-image ICO. Feed it the
// already-Lanczos'd PNGs so every frame is supersampled, not re-scaled from one bitmap.
py(`
from PIL import Image
imgs = [Image.open(r"${icoParts[icoParts.length - 1]}").convert("RGBA")]
${icoParts.slice(0, -1).map((f) => `imgs.append(Image.open(r"${f}").convert("RGBA"))`).join('\n')}
imgs[0].save(r"${icoOut}", format="ICO", sizes=[${icoSizes.map((s) => `(${s},${s})`).join(',')}],
             append_images=imgs[1:])
`);
console.log(`  ${icoOut.replace(resolve(extRoot, '..'), '.')}  (${readFileSync(icoOut).length.toLocaleString()} B)`);

await browser.close();

console.log('\nDone. Remember: after an icon change, re-run `pnpm pack:ext` so the');
console.log('committed discerned-web/public/discerned-extension.zip carries the new art.');
