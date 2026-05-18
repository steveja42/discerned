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
  document.open();
  document.write(html);
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
