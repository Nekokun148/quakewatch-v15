import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStrongMotionProxy } from './strong-motion-proxy.mjs';

const pages = process.argv.includes('--pages');
const root = fileURLToPath(new URL(pages ? '../dist/' : '../', import.meta.url));
const base = pages ? '/quakewatch-v15/' : '/';
const port = Number(process.argv[2] || 5173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/geo+json', '.svg': 'image/svg+xml' };
const strongMotionProxy = createStrongMotionProxy();
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith(base)) { response.writeHead(404).end('Not found'); return; }
    if (await strongMotionProxy(request, response, url, base)) return;
    const relative = pathname.slice(base.length);
    const file = resolve(root, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': (types[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`QuakeWatch: http://127.0.0.1:${port}${base}`));
