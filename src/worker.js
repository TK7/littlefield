// Cloudflare Worker entry point.
// Static files in public/ are served by Workers static assets; only /api/* reaches this code
// (see run_worker_first in wrangler.jsonc).
import { onRequestPost as ingest } from './api/ingest.js';
import { onRequestGet as snapshot } from './api/snapshot.js';
import { onChat, onChatLog, onConfig } from './api/chat.js';

const ROUTES = {
  '/api/ingest': { POST: ingest },
  '/api/snapshot': { GET: snapshot },
  '/api/chat': { POST: onChat },
  '/api/chatlog': { GET: onChatLog },
  '/api/config': { GET: onConfig },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = ROUTES[url.pathname.replace(/\/+$/, '')];
    if (route) {
      const handler = route[request.method];
      if (!handler) {
        return json({ error: 'Use ' + Object.keys(route).join(' or ') + '.' }, 405, { allow: Object.keys(route).join(', ') });
      }
      return handler({ request, env, ctx });
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    return env.ASSETS.fetch(request);
  },
};

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
