import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const allowed = new Set(['index.html', 'app.js', 'styles.css', 'sw.js', 'icon.svg', 'manifest.webmanifest', 'src/domain.mjs', 'src/database.mjs', 'src/schema.mjs', 'src/pwa.mjs', 'vendor/sql.js/sql-wasm.js', 'vendor/sql.js/sql-wasm.wasm']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const port = Number(process.argv[2] || process.env.PORT || 4173);
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['GET', 'HEAD'].includes(request.method) || !allowed.has(file)) { response.writeHead(404); response.end('Not found'); return; }
    const content = await readFile(path.join(root, file));
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other server or run: node server.mjs 4175` : error.message); process.exitCode = 1; });
server.listen(port, '0.0.0.0', () => console.log(`Maintainr: http://localhost:${port}`));
