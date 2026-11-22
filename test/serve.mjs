// Local preview without Cloudflare:  node test/serve.mjs [fixture.json] [port]
// Serves public/ and runs the Worker's /api routes against an in-memory store.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../src/api/ingest.js';
import worker from '../src/worker.js';
import { mockKV } from './mock-kv.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const fixture = process.argv[2] || fileURLToPath(new URL('./fixtures/extracts/final-268.json', import.meta.url));
const port = Number(process.argv[3] || 8788);
// The advisor: a real key in ANTHROPIC_API_KEY calls Claude (and is billed); without one,
// a canned local answer is streamed so the drawer can be tried for free.
const env = { LF_KV: mockKV(), INGEST_SECRET: 'local-secret-local-secret', DEV_ALLOW_ANON: '1',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'local-fake-key',
  ANTHROPIC_FETCH: process.env.ANTHROPIC_API_KEY ? undefined : fakeAdvisor };

async function fakeAdvisor(url, init) {
  const body = JSON.parse(init.body);
  const last = body.messages.at(-1).content;
  const day = (/snapshot Day (\d+)/.exec(last) || [])[1];
  const text = 'Status: Local preview, no Claude call was made.\nEvidence: the telemetry for Day ' + day + ' arrived ('
    + last.length + ' characters).\nAction: set ANTHROPIC_API_KEY to try the real advisor.\nWhat would change this: a real API key.';
  const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
  const parts = [ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'local-preview', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...text.match(/.{1,16}/gs).map((c) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })),
    ev('content_block_stop', { index: 0 }), ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }), ev('message_stop', {})];
  return new Response(parts.join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// The named extracts in test/fixtures/extracts/ are always loaded, so the extract switcher
// and the presentation chapters work locally. The live snapshot is the fixture given (default:
// the final extract).
const extractDir = fileURLToPath(new URL('./fixtures/extracts/', import.meta.url));
const ingest = async (body) => onRequestPost({ env, request: new Request('http://local/api/ingest', {
  method: 'POST', headers: { 'x-ingest-secret': env.INGEST_SECRET }, body }) });
for (const name of (await readdir(extractDir)).filter((n) => n.endsWith('.json')).sort()) {
  const res = await ingest(await readFile(extractDir + name));
  console.log('extract:', name, res.status);
}
if (fixture !== 'none') {
  const snap = JSON.parse(await readFile(fixture));
  delete snap.extract;
  const res = await ingest(JSON.stringify(snap));
  console.log('seeded:', await res.text());
}

// PORTFOLIO_MODE=1 node test/serve.mjs  previews the portfolio version (set after seeding).
if (process.env.PORTFOLIO_MODE) env.PORTFOLIO_MODE = process.env.PORTFOLIO_MODE;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + port);
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
      const out = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env, { waitUntil() {} });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (out.body) for await (const chunk of out.body) res.write(chunk);
      return res.end();
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
