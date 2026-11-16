// The JavaScript simulator must reproduce the Python reference model.
// Golden results: sim/littlefield/golden.py -> test/fixtures/sim-golden.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate, policy, startState, defaultConfig, PRIORITY_STEP4 } from '../public/sim/model.js';
import { daily, startFromSnapshot, measuredPtimes, configFromSnapshot } from '../public/sim/snapshot.js';
import { Rng } from '../public/sim/rng.js';

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url)));
const golden = fixture('sim-golden.json');
const close = (a, b, what, tol = 1e-7) => {
  if (a === null || b === null) return assert.equal(a, b, what);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), what + ': ' + a + ' vs ' + b);
};

export function replayArrivals(days, rng) {
  const out = [];
  for (const d of days) {
    const xs = [];
    for (let i = 0; i < Math.trunc(d.accepted); i++) xs.push(d.day - 1 + rng.random());
    xs.sort((x, y) => x - y);
    out.push(...xs);
  }
  return out;
}

function compareRun(js, py, label) {
  assert.equal(js.days.length, py.days.length, label + ' days');
  js.days.forEach((d, i) => {
    const p = py.days[i];
    const at = label + ' day ' + p.day;
    for (const k of ['day', 'accepted', 'rejected', 'completed', 'kits', 'wip', 'contract']) assert.equal(d[k], p[k], at + ' ' + k);
    for (const k of ['revenue', 'lead', 'waiting', 'cash']) close(d[k], p[k], at + ' ' + k);
    for (let s = 0; s < 3; s++) { close(d.queue[s], p.queue[s], at + ' queue'); close(d.util[s], p.util[s], at + ' util'); }
  });
  assert.equal(js.orders.length, py.orders.length, label + ' orders');
  js.orders.forEach(([t, q], i) => { close(t, py.orders[i][0], label + ' order time'); assert.equal(q, py.orders[i][1]); });
  assert.deepEqual(js.purchases, py.purchases, label + ' purchases');
  close(js.finalCash, py.final_cash, label + ' final cash');
}

export const tests = [];
const test = (name, fn) => tests.push([name, fn]);

for (const name of ['day50', 'day59-synthetic', 'day64']) {
  test('sim: snapshot reading matches Python (' + name + ')', () => {
    const snap = fixture(name + '.json');
    const g = golden.snapshots[name];
    daily(snap).forEach((d, i) => {
      const p = g.daily[i];
      assert.deepEqual([d.day, d.kitsOrdered, d.kitPosition, d.wip, d.contract], [p.day, p.kits_ordered, p.kit_position, p.wip, p.contract]);
    });
    const st = startFromSnapshot(snap);
    const ps = g.start;
    assert.deepEqual([st.day, st.cash, st.machines, st.kits, st.orderArrives, st.orderQty, st.contract, st.rop, st.qty, st.schedule],
      [ps.day, ps.cash, ps.machines, ps.kits, ps.order_arrives, ps.order_qty, ps.contract, ps.rop, ps.qty, ps.schedule]);
    assert.equal(st.jobs.length, ps.jobs.length);
    st.jobs.forEach((j, i) => { close(j[0], ps.jobs[i][0], 'job time'); assert.equal(j[1], ps.jobs[i][1]); assert.equal(j[2], ps.jobs[i][2]); });
    assert.deepEqual(measuredPtimes(snap), g.ptimes);
  });
}

test('sim: whole game with purchases, contract ladder and final order matches Python', () => {
  const pol = policy({ machines: { 30: [3, 4, 3] }, rop: { 30: 6000 }, qty: { 30: 26700 }, schedule: { 30: PRIORITY_STEP4 }, ladder: true, finalDay: 200 });
  const r = simulate({ cfg: defaultConfig(), pol, start: startState(), seed: 11, demand: 15.5 });
  compareRun(r, golden.runs.A.result, 'A');
});

test('sim: run from the Day 64 snapshot matches Python', () => {
  const snap = fixture('day64.json');
  const r = simulate({ cfg: configFromSnapshot(snap), pol: policy({ finalDay: 210 }), start: startFromSnapshot(snap), seed: 4, demand: 13.6 });
  compareRun(r, golden.runs.B.result, 'B');
});

test('sim: replay of Days 1-50 matches Python', () => {
  const snap = fixture('day50.json');
  const arrivals = replayArrivals(daily(snap), new Rng(10001));
  const r = simulate({ cfg: configFromSnapshot(snap), pol: policy(), start: startState(), seed: 1, arrivals });
  compareRun(r, golden.runs.C.result, 'C');
});

if (import.meta.url === 'file://' + process.argv[1]) {
  for (const [name, fn] of tests) { await fn(); console.log('ok  ' + name); }
}
