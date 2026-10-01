// Load a fixture HTML file into the active jsdom document, and override
// window.location so the extractors see a deterministic URL.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURE_ROOT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'sites');

export function fixturePath(name: string): string {
  return resolve(FIXTURE_ROOT, name);
}

export function loadFixture(name: string, url: string): void {
  const html = readFileSync(fixturePath(name), 'utf8');
  // Vitest's jsdom env runs with `runScripts: 'dangerously'`, so `document.write`
  // EXECUTES any inline <script> in the fixture. Real-page snapshots (reddit,
  // youtube, …) bundle the site's own JS, which throws under jsdom (`SML is not
  // defined`, `responseStart`, …). Those surface as uncaught errors that fail the
  // run with a non-zero exit even when every test passes. The capture pipeline
  // only reads DOM structure — it never needs page scripts to run, and the
  // sanitiser strips <script> from the captured output regardless — so neutralise
  // them at the door. (The sanitiser XSS test injects its payload via a fixture
  // and asserts the *captured* HTML is script-free, which is unaffected.)
  const inert = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  document.open();
  document.write(inert);
  document.close();

  // jsdom doesn't allow direct assignment to window.location; override the
  // property with a structurally compatible URL-like object covering the
  // pieces capture.ts touches: href, origin, pathname, search, hash.
  const u = new URL(url);
  const locationLike = {
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
    toString() { return u.href; },
  };
  Object.defineProperty(window, 'location', {
    value: locationLike,
    writable: true,
    configurable: true,
  });
}
