// Minimal static server for running the app locally: node tools/serve.mjs [port]
// Web MIDI and WebUSB need a secure context - http://localhost counts as one.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.bin': 'application/octet-stream',
  '.dfu': 'application/octet-stream',
};

export function startServer(p = port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      if (path.includes('..')) throw new Error('bad path');
      let file = join(root, path || 'index.html');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(p, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(() => console.log(`Neutron Editor: http://localhost:${port}`));
}
