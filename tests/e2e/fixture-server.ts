// Tiny static HTTP server for fixture HTML pages.
// Started by Playwright's webServer (or manually for ad-hoc runs).
// Serves c:\dev\discerned\tests\fixtures\sites\ on http://127.0.0.1:4173/<basename>
//   + /_health for the webServer wait probe.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.FIXTURE_PORT ?? 4173);
const ROOT = resolve(__dirname, '..', 'fixtures', 'sites');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/_health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const name = basename(url.pathname);
    if (!name || name.includes('..')) {
      res.writeHead(400); res.end('bad path'); return;
    }

    const filePath = resolve(ROOT, name);
    if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
      res.writeHead(404); res.end('not found'); return;
    }

    const body = await readFile(filePath);
    const type = CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[fixture-server] http://127.0.0.1:${PORT}  root=${ROOT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
