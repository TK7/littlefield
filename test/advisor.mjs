// Phase 3: the advisor endpoint, the usage log, Access token checks, and the telemetry
// the dashboard builds. The Claude API is replaced by a local stand-in: nothing is billed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { verifyAccessJwt } from '../src/access.js';
import { SYSTEM_PROMPT } from '../src/advisor/prompt.js';
import { mockKV } from './mock-kv.mjs';
import { derive } from '../public/derive.js';
import { baseTelemetry, competitorData } from '../public/advisor.js';

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url)));
export const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A stand-in for the Messages API that streams a short answer and records the request.
function fakeClaude({ text = 'Status: Hold.\nEvidence: lead time 0.46 days.', stop = 'end_turn', status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    if (status !== 200) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        { status, headers: { 'content-type': 'application/json' } });
    }
    const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
    const parts = [
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 700, cache_creation_input_tokens: 0 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ...text.match(/.{1,12}/gs).map((chunk) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } })),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } }),
      ev('message_stop', {}),
    ];
    return new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  fn.calls = calls;
  return fn;
}

function setup(over = {}) {
  const waits = [];
  const env = { LF_KV: mockKV(), ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_FETCH: fakeClaude(), ...over };
  const call = (path, init = {}, headers = { 'cf-access-authenticated-user-email': 'jay@example.edu' }) =>
    worker.fetch(new Request('https://x.test' + path, { ...init, headers: { ...headers, ...(init.headers || {}) } }), env, { waitUntil: (p) => waits.push(p) });
  const settle = () => Promise.all(waits);
  return { env, call, settle };
}
const ask = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const telemetry = { day: 64, receivedAt: '2026-11-16T02:08:36Z', cash: 792147 };
async function readNdjson(res) {
  return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
}

test('advisor: refuses requests without a Cloudflare Access identity', async () => {
  const { call } = setup();
  assert.equal((await call('/api/chat', ask({ question: 'hi', telemetry }), {})).status, 401);
  assert.equal((await call('/api/chatlog', {}, {})).status, 401);
});

test('advisor: refuses to run without the API key, and rejects malformed requests', async () => {
  assert.equal((await setup({ ANTHROPIC_API_KEY: undefined }).call('/api/chat', ask({ question: 'hi', telemetry }))).status, 503);
  const { call, env } = setup();
  for (const body of [{ telemetry }, { question: ' ', telemetry }, { question: 'hi' }, { question: 'hi', telemetry: { cash: 1 } },
    { briefing: 'nope', telemetry }, { question: 'x'.repeat(2001), telemetry }, { question: 'hi', telemetry, history: [{ role: 'assistant', text: 'a' }] }]) {
    assert.equal((await call('/api/chat', ask(body))).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(env.ANTHROPIC_FETCH.calls.length, 0);
});

test('advisor: streams the answer, sends a cached system prompt to Sonnet with fallbacks, and logs it', async () => {
  const { call, env, settle } = setup();
  const res = await call('/api/chat', ask({ question: 'Should we buy a machine?', telemetry, history: [{ role: 'user', text: 'Earlier q' }, { role: 'assistant', text: 'Earlier a' }] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-snapshot-day'), '64');
  const lines = await readNdjson(res);
  assert.equal(lines.filter((l) => l.t === 'text').map((l) => l.v).join(''), 'Status: Hold.\nEvidence: lead time 0.46 days.');
  const done = lines.at(-1);
  assert.equal(done.t, 'done');
  assert.equal(done.stop, 'end_turn');
  assert.equal(done.usage.cacheRead, 700);
  assert.equal(done.remaining, 59);
  await settle();

  const sent = env.ANTHROPIC_FETCH.calls[0];
  assert.match(sent.url, /\/v1\/messages/);
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(sent.headers.authorization, 'Bearer sk-test');
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.body.max_tokens, 4000);
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.output_config, { effort: 'low' });
  assert.equal(sent.body.system[0].text, SYSTEM_PROMPT);
  assert.deepEqual(sent.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(sent.body.messages.length, 3);
  assert.match(sent.body.messages[2].content, /snapshot Day 64/);
  assert.match(sent.body.messages[2].content, /Question: Should we buy a machine\?$/);
  assert.ok(!('temperature' in sent.body));

  const logs = [...env.LF_KV.store.keys()].filter((k) => k.startsWith('log:'));
  assert.equal(logs.length, 1);
  const entry = JSON.parse(env.LF_KV.store.get(logs[0]));
  assert.equal(entry.email, 'jay@example.edu');
  assert.equal(entry.snapshotDay, 64);
  assert.equal(entry.answer, 'Status: Hold.\nEvidence: lead time 0.46 days.');
  assert.equal(entry.usage.output, 42);
});

test('advisor: the system prompt is long enough to be cached and has no per-request content', () => {
  assert.ok(SYSTEM_PROMPT.length > 2500, 'about 600+ tokens; the cacheable minimum for Sonnet 5.5 is 512');
  assert.doesNotMatch(SYSTEM_PROMPT, /Day 6\d|\$792/);
});

test('advisor: briefings send the fixed briefing request, and the daily cap stops further questions', async () => {
  const { call, env } = setup({ CHAT_DAILY_CAP: '2' });
  await readNdjson(await call('/api/chat', ask({ briefing: 'endgame', telemetry })));
  assert.match(env.ANTHROPIC_FETCH.calls[0].body.messages[0].content, /Briefing request: End-game kit order/);
  await readNdjson(await call('/api/chat', ask({ question: 'second', telemetry })));
  const third = await call('/api/chat', ask({ question: 'third', telemetry }));
  assert.equal(third.status, 429);
  assert.equal(env.ANTHROPIC_FETCH.calls.length, 2);
});

test('advisor: API errors, refusals and cut-off answers reach the drawer as notes', async () => {
  let lines = await readNdjson(await setup({ ANTHROPIC_FETCH: fakeClaude({ status: 401 }) }).call('/api/chat', ask({ question: 'hi', telemetry })));
  assert.equal(lines.at(-1).error, true);
  assert.match(lines.at(-1).note, /rejected the key/);
  lines = await readNdjson(await setup({ ANTHROPIC_FETCH: fakeClaude({ stop: 'refusal' }) }).call('/api/chat', ask({ question: 'hi', telemetry })));
  assert.match(lines.at(-1).note, /declined/);
  lines = await readNdjson(await setup({ ANTHROPIC_FETCH: fakeClaude({ stop: 'max_tokens' }) }).call('/api/chat', ask({ question: 'hi', telemetry })));
  assert.match(lines.at(-1).note, /length cap/);
});

test('advisor: the log exports as Markdown and JSON for the AI disclosure', async () => {
  const { call, settle } = setup();
  await readNdjson(await call('/api/chat', ask({ question: 'What is our lead time?', telemetry })));
  await settle();
  const md = await (await call('/api/chatlog?format=md')).text();
  assert.match(md, /snapshot Day 64, asked by jay@example.edu/);
  assert.match(md, /\*\*Question:\*\* What is our lead time\?/);
  const js = await (await call('/api/chatlog?format=json')).json();
  assert.equal(js.entries.length, 1);
});

test('access: verifies Cloudflare Access tokens (signature, audience, issuer, expiry)', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async (claims) => {
    const head = b64({ alg: 'RS256', kid: 'k1' }) + '.' + b64(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head));
    return head + '.' + Buffer.from(sig).toString('base64url');
  };
  const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud123',
    ACCESS_FETCH: async () => new Response(JSON.stringify({ keys: [jwk] })) };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: 'https://team.cloudflareaccess.com', aud: ['aud123'], exp: now + 600, email: 'laura@uni.edu' };
  assert.equal((await verifyAccessJwt(await sign(good), env)).email, 'laura@uni.edu');
  for (const bad of [{ ...good, aud: ['other'] }, { ...good, exp: now - 5 }, { ...good, iss: 'https://evil.example' }]) {
    await assert.rejects(verifyAccessJwt(await sign(bad), env));
  }
  const tampered = (await sign(good)).replace(/\.[^.]+\./, '.' + b64({ ...good, email: 'x@y.z' }) + '.');
  await assert.rejects(verifyAccessJwt(tampered, env));

  // Through the endpoint: with Access configured, the email header alone is not enough.
  const { call } = setup(env);
  assert.equal((await call('/api/chatlog')).status, 401);
  const ok = await call('/api/chatlog', {}, { 'cf-access-jwt-assertion': await sign(good) });
  assert.equal(ok.status, 200);
});

test('advisor: telemetry carries the computed numbers, the Playbook and stays small', () => {
  const snap = fixture('day64.json');
  const t = baseTelemetry(snap, derive(snap.raw, snap.settings), null);
  assert.equal(t.day, 64);
  assert.equal(t.cash, 792147);
  assert.equal(t.contractTakingOrders, 3);
  assert.deepEqual(t.machines, [3, 4, 3]);
  assert.equal(t.playbook.length, 12);
  assert.equal(t.revenuePerJob.latestDay, 1137);
  assert.ok(JSON.stringify(t).length < 12000);
});

test('advisor: competitor forensics from the leaderboard rows', () => {
  const snap = fixture('day64.json');
  const c = competitorData(snap, 64);
  assert.deepEqual(c.leaderboardRowDays, [50, 55, 58, 60]);
  assert.equal(c.daysBehindSnapshot, 4);
  const us = c.teams.find((t) => t.ours);
  assert.equal(us.team, 'ATeam');
  assert.equal(us.cashChangePerDayLatestInterval, 9313);           // (734,018 - 715,392) / 2
  assert.equal(us.nearestSignatureLatestInterval, '$1,250 contract');
  assert.deepEqual(us.largestRecentDrop.betweenDays, [50, 55]);     // the restart machine purchases
  assert.equal(c.teams[0].team, 'donothing');                       // most cash on Day 60
});

if (import.meta.url === 'file://' + process.argv[1]) {
  for (const [name, fn] of tests) { await fn(); console.log('ok  ' + name); }
}
