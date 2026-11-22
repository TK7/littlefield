// Run with:  node test/run.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestPost } from '../src/api/ingest.js';
import worker from '../src/worker.js';
import { onRequestGet } from '../src/api/snapshot.js';
import { derive } from '../public/derive.js';
import { mockKV } from './mock-kv.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url)));
const day50 = fixture('day50.json');
const day59 = fixture('day59-synthetic.json');
const SECRET = 'test-secret-1234567890';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };
const post = (env, body, secret = SECRET) => onRequestPost({
  env,
  request: new Request('https://x.test/api/ingest', { method: 'POST', headers: { 'x-ingest-secret': secret }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const get = (env, qs = '') => onRequestGet({ env, request: new Request('https://x.test/api/snapshot' + qs) });

await test('ingest rejects a wrong or missing secret', async () => {
  const env = { LF_KV: mockKV(), INGEST_SECRET: SECRET };
  assert.equal((await post(env, day50, 'wrong')).status, 401);
  assert.equal((await post(env, day50, '')).status, 401);
  assert.equal(env.LF_KV.store.size, 0);
});
await test('ingest refuses to run when not configured', async () => {
  assert.equal((await post({ LF_KV: mockKV() }, day50)).status, 500);
  assert.equal((await post({ INGEST_SECRET: SECRET }, day50)).status, 500);
});
await test('ingest rejects malformed snapshots', async () => {
  const env = { LF_KV: mockKV(), INGEST_SECRET: SECRET };
  assert.equal((await post(env, 'not json')).status, 400);
  assert.equal((await post(env, { ...day50, schema: 2 })).status, 400);
  assert.equal((await post(env, { ...day50, raw: [] })).status, 400);
  assert.equal((await post(env, { ...day50, raw: [[1, 2, 3]] })).status, 400);
  assert.equal((await post(env, { ...day50, raw: [day50.raw[0].map(() => 'x')] })).status, 400);
  assert.equal((await post(env, { ...day50, playbook: undefined })).status, 400);
  assert.equal(env.LF_KV.store.size, 0);
});
await test('ingest stores latest and a per-day copy; snapshot returns them', async () => {
  const env = { LF_KV: mockKV(), INGEST_SECRET: SECRET };
  const r1 = await post(env, day50);
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).day, 50);
  assert.equal((await post(env, day59)).status, 200);
  const latest = await (await get(env)).json();
  assert.equal(latest.latestDay, 59);
  assert.ok(latest.receivedAt);
  const older = await (await get(env, '?day=50')).json();
  assert.equal(older.latestDay, 50);
  assert.deepEqual((await (await get(env, '?list=1')).json()).days, [50, 59]);
  assert.equal((await get(env, '?day=77')).status, 404);
  assert.equal((await get(env, '?day=abc')).status, 400);
});
await test('named extracts: stored under their name, listed by day, never replace the live snapshot', async () => {
  const env = { LF_KV: mockKV(), INGEST_SECRET: SECRET };
  await post(env, day59);
  assert.equal((await post(env, { ...day50, extract: { slug: 'day-50', label: 'Day 50: restart', file: 'Day 50.xlsx' } })).status, 200);
  assert.equal((await post(env, { ...day50, extract: { slug: 'Bad Slug', label: 'x' } })).status, 400);
  assert.equal((await post(env, { ...day50, extract: { slug: 'ok', label: '' } })).status, 400);
  assert.equal((await (await get(env)).json()).latestDay, 59);           // live snapshot unchanged
  const list = (await (await get(env, '?extracts=1')).json()).extracts;
  assert.deepEqual(list.map((x) => [x.slug, x.label, x.day, x.file]), [['day-50', 'Day 50: restart', 50, 'Day 50.xlsx']]);
  assert.equal((await (await get(env, '?extract=day-50')).json()).latestDay, 50);
  assert.equal((await get(env, '?extract=nope')).status, 404);
  assert.equal((await get(env, '?extract=../x')).status, 400);
});
await test('portfolio mode: ingest is read-only', async () => {
  const env = { LF_KV: mockKV(), INGEST_SECRET: SECRET, PORTFOLIO_MODE: '1' };
  assert.equal((await post(env, day50)).status, 403);
  assert.equal(env.LF_KV.store.size, 0);
});

await test('curate script keeps only question, answer, day and briefing', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(tmpdir() + '/curate-');
  const log = dir + '/log.json';
  writeFileSync(log, JSON.stringify({ entries: [
    { email: 'a@b.edu', question: 'Q1', answer: 'A1', snapshotDay: 64, briefing: null, telemetry: { day: 64 }, model: 'm' },
    { email: 'c@d.edu', question: 'long text', answer: 'A2', snapshotDay: 198, briefing: 'endgame', telemetry: {}, model: 'm' },
    { email: 'e@f.edu', question: 'Q3', answer: '', note: 'failed', snapshotDay: 70 },
  ] }));
  const target = new URL('../public/advisor-examples.json', import.meta.url);
  const backup = dir + '/backup.json';
  copyFileSync(target, backup);
  try {
    execFileSync('node', [new URL('../scripts/curate-advisor.mjs', import.meta.url).pathname, log, '2', '1']);
    const out = JSON.parse(readFileSync(target, 'utf8'));
    assert.deepEqual(out.examples.map((e) => [e.snapshotDay, e.question, e.answer]), [[198, 'End-game kit order', 'A2'], [64, 'Q1', 'A1']]);
    assert.doesNotMatch(JSON.stringify(out), /@|telemetry/);
  } finally {
    copyFileSync(backup, target);
  }
});

await test('snapshot returns 404 before any data arrives', async () => {
  assert.equal((await get({ LF_KV: mockKV() })).status, 404);
});
await test('worker routes /api/*, rejects wrong methods, hands everything else to static assets', async () => {
  const env = { LF_KV: mockKV(), INGEST_SECRET: SECRET, ASSETS: { fetch: async () => new Response('asset') } };
  const call = (path, init) => worker.fetch(new Request('https://x.test' + path, init), env, {});
  assert.equal((await call('/api/ingest', { method: 'GET' })).status, 405);
  assert.equal((await call('/api/snapshot', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/snapshot')).status, 404); // nothing stored yet
  const r = await call('/api/ingest', { method: 'POST', headers: { 'x-ingest-secret': SECRET }, body: JSON.stringify(day50) });
  assert.equal(r.status, 200);
  assert.equal((await (await call('/api/snapshot/')).json()).latestDay, 50);
  assert.equal(await (await call('/')).text(), 'asset');
});
await test('derive: blank (zero) settings from the Sheet do not replace defaults', async () => {
  const m = derive(day50.raw, { ...day50.settings, startCash: 0, startKits: 0, kitCost: 0 });
  assert.deepEqual(m.events.filter((e) => e.type === 'kits').map((e) => e.day), [9, 16, 25, 32, 41, 48]);
  assert.equal(m.days.at(-1).kitPosition, 6300);
});

await test('derive: Day 50 matches the Sheet (kit orders, stockouts, WIP, kit position)', async () => {
  const m = derive(day50.raw, day50.settings);
  const kits = m.events.filter((e) => e.type === 'kits');
  assert.deepEqual(kits.map((e) => e.day), [9, 16, 25, 32, 41, 48]);
  assert.ok(m.days.filter((d) => d.kitsOrdered).every((d) => d.kitsOrdered === 7200));
  assert.equal(m.events.filter((e) => e.type !== 'kits').length, 0);
  assert.equal(m.stockouts.length, 6);
  assert.deepEqual(m.stockouts.map((w) => w.start), [11, 18, 27, 34, 43, 50]);
  assert.equal(m.stockouts.reduce((t, w) => t + w.length, 0), 16);
  assert.ok(Math.abs(Math.max(...m.stockouts.map((w) => w.peak)) - 39.633) < 0.001);
  const last = m.days.at(-1);
  assert.equal(last.wip, 68);
  assert.equal(last.kitPosition, 6300);
  assert.equal(last.kitsOnOrder, 7200);
  assert.equal(last.kitsOnHand, 0);
  assert.equal(last.cash, 1106279);
  assert.equal(last.contract, 1);
});
await test('derive: synthetic Day 59 detects machine purchases, a kit order, contract switches and a sale', async () => {
  const m = derive(day59.raw, day59.settings);
  const on = (day) => m.events.filter((e) => e.day === day).map((e) => e.label);
  assert.deepEqual(on(51), ['Bought 1 at Station 1', 'Bought 1 at Station 2', 'Bought 1 at Station 3']);
  assert.deepEqual(on(52), ['Kit order, 26,700 kits']);
  assert.deepEqual(on(55), ['Contract 1 to 2']);
  assert.deepEqual(on(57), ['Contract 2 to 3']);
  assert.deepEqual(on(58), ['Sold 1 at Station 1']);
  assert.equal(m.days.at(-1).kitPosition, 24600);
});

// Phase 2: the simulator against the Python reference, and the worker's answers.
const { tests: simTests } = await import('./sim.mjs');
for (const [name, fn] of simTests) await test(name, fn);

const { handlers, policyFrom } = await import('../public/sim/worker.js');
await test('worker: current settings reproduce the Do nothing line; presets rank as expected', async () => {
  const snap = fixture('day64.json');
  const init = handlers.init({ snap, runs: 20 });
  const live = { machines: init.start.machines, schedule: init.start.schedule, contract: init.start.contract, ladder: false,
    rop: init.start.rop, qty: init.start.qty, finalDay: 0, demand: init.demand };
  const w = handlers.whatif({ settings: live, runs: 20 });
  assert.equal(w.line.finalP50, init.lines['Do nothing'].finalP50);
  const rec = init.lines['Recommended (3/4/3, up to $1,250)'], safe = init.lines['Safe (3/4/3, up to $1,000)'];
  assert.ok(rec.finalP50 > init.lines['Do nothing'].finalP50, 'the final order is worth having');
  assert.ok(rec.finalP50 > safe.finalP50, '$1,250 beats $1,000 at 3/4/3');
  assert.equal(rec.switchRuns[2], 0, 'already on $1,250: the ladder never steps down');
  assert.ok(w.here.leadMean > 0.4 && w.here.leadMean < 0.6);
  const pol = policyFrom(init.start, { ...live, ladder: true, contract: 2, finalDay: 210 });
  assert.equal(pol.ladderTop, 2);
  assert.equal(pol.finalDay, 210);
});
await test('worker: final order table covers the window and every order goes through', async () => {
  const snap = fixture('day64.json');
  handlers.init({ snap, runs: 2 });
  const f = handlers.final({ settings: { machines: [3, 4, 3], schedule: 'Prioritize Step 4', contract: 3, ladder: false, rop: 6000, qty: 26700 }, runs: 6 });
  assert.equal(f.rows[0].day, 193);
  assert.equal(f.rows.at(-1).day, 217);
  assert.ok(f.rows.every((r) => r.fires === 1));
  // Day 64 fixture: Settings planning demand 15.5 jobs a day drives the size (930 kits a day).
  assert.ok(f.rows[0].size > 55000 && f.rows[0].size < 68000, String(f.rows[0].size));
  assert.equal(f.rows.length, 25);                              // every day, 193 to 217
  assert.ok(f.nextRegular.day > 70 && f.nextRegular.day < 90);  // 21,540 kits on hand, reorder point 6,000
  assert.equal(f.sizeRule.kitsPerDay, 930);
  const init = handlers.init({ snap, runs: 2 });
  assert.equal(init.demandSource, 'plan');
  assert.deepEqual(init.lastOrder, { day: 52, kits: 26700 });
});

// Phase 3: the advisor.
const { tests: advisorTests } = await import('./advisor.mjs');
for (const [name, fn] of advisorTests) await test(name, fn);

console.log('\n' + passed + ' tests passed');
