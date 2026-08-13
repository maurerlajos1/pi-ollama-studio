import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = await fs.realpath(process.cwd());
const entryAt = process.argv.indexOf('--studio-entry');
const rawEntry = entryAt >= 0 ? String(process.argv[entryAt + 1] || '') : '';
if (rawEntry && (path.isAbsolute(rawEntry) || rawEntry.includes('\0'))) throw new Error('Invalid static Preview entry path');
const entryParts = rawEntry.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
if (entryParts.some((part) => part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid static Preview entry path');
const entryUrl = entryParts.length ? `/${entryParts.map(encodeURIComponent).join('/')}/` : '/';
const types = new Map([
  ['.html','text/html; charset=utf-8'],['.htm','text/html; charset=utf-8'],['.css','text/css; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.mjs','text/javascript; charset=utf-8'],['.json','application/json; charset=utf-8'],['.svg','image/svg+xml'],['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.gif','image/gif'],['.webp','image/webp'],['.ico','image/x-icon'],['.txt','text/plain; charset=utf-8'],['.woff','font/woff'],['.woff2','font/woff2']
]);

function insideRoot(target) {
  const rel = path.relative(root, target);
  return target === root || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0')) throw Object.assign(new Error('Invalid path'), { statusCode: 400 });
    let target = path.resolve(root, `.${pathname}`);
    if (!insideRoot(target)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    let stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fs.stat(target).catch(() => null);
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Not found');
      return;
    }
    const real = await fs.realpath(target);
    if (!insideRoot(real)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const body = await fs.readFile(real);
    res.writeHead(200, {
      'content-type': types.get(path.extname(real).toLowerCase()) || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (error) {
    res.writeHead(error?.statusCode || 500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(error?.statusCode ? error.message : 'Preview server error');
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Studio static preview http://127.0.0.1:${address.port}${entryUrl}`);
});

for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
