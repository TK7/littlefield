// GET /api/snapshot           -> the latest snapshot
// GET /api/snapshot?day=57    -> the snapshot stored for simulated Day 57
// GET /api/snapshot?list=1    -> the simulated days that have a stored snapshot
// GET /api/snapshot?extracts=1          -> the named extracts pushed from the Sheet
// GET /api/snapshot?extract=day-198     -> one named extract
//
// This route has no secret of its own. It is protected by Cloudflare Access,
// which must cover the whole site (see docs/OPERATIONS.md).
// The Worker's workers.dev and preview URLs are switched off in wrangler.jsonc so
// there is no address that skips Access.

export async function onRequestGet({ request, env }) {
  if (!env.LF_KV) return json({ error: 'Server not configured: LF_KV binding is missing.' }, 500);
  const url = new URL(request.url);

  if (url.searchParams.get('list')) {
    const listed = await env.LF_KV.list({ prefix: 'day:' });
    const days = listed.keys.map((k) => Number(k.name.slice(4))).filter((n) => Number.isFinite(n));
    days.sort((a, b) => a - b);
    return json({ days });
  }

  if (url.searchParams.get('extracts')) {
    const extracts = [];
    let cursor;
    do {
      const page = await env.LF_KV.list({ prefix: 'extract:', cursor });
      for (const k of page.keys) extracts.push(k.metadata || { slug: k.name.slice(8), label: k.name.slice(8) });
      cursor = page.list_complete === false ? page.cursor : undefined;
    } while (cursor);
    extracts.sort((a, b) => (a.day || 0) - (b.day || 0) || String(a.label).localeCompare(String(b.label)));
    return json({ extracts });
  }

  const slug = url.searchParams.get('extract');
  if (slug !== null) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) return json({ error: 'Unknown extract.' }, 400);
    const stored = await env.LF_KV.get('extract:' + slug);
    if (stored === null) return json({ error: 'No extract with that name.' }, 404);
    return new Response(stored, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }

  const dayParam = url.searchParams.get('day');
  let key = 'latest';
  if (dayParam !== null) {
    const day = Number(dayParam);
    if (!Number.isInteger(day) || day < 0 || day > 999) return json({ error: 'day must be a whole number.' }, 400);
    key = 'day:' + String(day).padStart(3, '0');
  }

  const stored = await env.LF_KV.get(key);
  if (stored === null) {
    return json({ error: key === 'latest' ? 'No snapshot has been received yet.' : 'No snapshot stored for that day.' }, 404);
  }
  return new Response(stored, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
