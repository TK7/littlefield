// POST /api/ingest
// Called by the Google Sheet's Apps Script after each import.
// Checks the shared secret, validates the snapshot, stores it in Workers KV.
//
// Required bindings (Worker > Settings > Variables and Secrets / Bindings):
//   LF_KV          KV namespace (declared in wrangler.jsonc)
//   INGEST_SECRET  secret text, same value as stored in the Sheet's script

const MAX_BYTES = 2_000_000;
const RAW_COLUMNS = 24;

export async function onRequestPost({ request, env }) {
  if (!env.LF_KV || !env.INGEST_SECRET) {
    return json({ error: 'Server not configured: LF_KV binding or INGEST_SECRET is missing.' }, 500);
  }
  const given = request.headers.get('x-ingest-secret') || '';
  if (!(await sameSecret(given, env.INGEST_SECRET))) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: 'Snapshot too large.' }, 413);

  let snap;
  try {
    snap = JSON.parse(text);
  } catch (e) {
    return json({ error: 'Body is not valid JSON.' }, 400);
  }
  const problem = validate(snap);
  if (problem) return json({ error: problem }, 400);

  const day = snap.raw.reduce((m, row) => Math.max(m, row[0]), 0);
  snap.latestDay = day;
  snap.receivedAt = new Date().toISOString();

  const stored = JSON.stringify(snap);
  await env.LF_KV.put('latest', stored);
  // One copy per simulated day, so earlier days can be replayed.
  await env.LF_KV.put('day:' + String(day).padStart(3, '0'), stored);

  return json({ ok: true, day, receivedAt: snap.receivedAt });
}


function validate(snap) {
  if (!snap || typeof snap !== 'object') return 'Snapshot must be an object.';
  if (snap.schema !== 1) return 'Unknown schema version.';
  if (!Array.isArray(snap.raw) || snap.raw.length === 0) return 'Snapshot has no daily rows.';
  if (snap.raw.length > 400) return 'Too many daily rows.';
  for (const row of snap.raw) {
    if (!Array.isArray(row) || row.length !== RAW_COLUMNS) return 'Each daily row must have ' + RAW_COLUMNS + ' values.';
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'Daily rows must contain only numbers.';
    }
  }
  if (!snap.settings || typeof snap.settings !== 'object') return 'Snapshot has no settings.';
  if (!Array.isArray(snap.playbook)) return 'Snapshot has no playbook statuses.';
  return null;
}

// Compare secrets without leaking where they differ: hash both, then compare every byte.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
