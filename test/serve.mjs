// Local preview without Cloudflare:  node test/serve.mjs [fixture.json] [port]
// Serves public/ and runs the Worker's /api routes against an in-memory store.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../src/api/ingest.js';
import worker from '../src/worker.js';
import { mockKV } from './mock-kv.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const fixture = process.argv[2] || fileURLToPath(new URL('./fixtures/day50.json', import.meta.url));
const port = Number(process.argv[3] || 8788);
const env = { LF_KV: mockKV(), INGEST_SECRET: 'local-secret-local-secret' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

if (fixture !== 'none') {
  const res = await onRequestPost({ env, request: new Request('http://local/api/ingest', {
    method: 'POST', headers: { 'x-ingest-secret': env.INGEST_SECRET }, body: await readFile(fixture) }) });
  console.log('seeded:', await res.text());
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + port);
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
      const out = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env, {});
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }
    const file = join(root, normalize(url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log('http://localhost:' + port));
