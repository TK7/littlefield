// Replaying the real game through the model. Port of the replay parts of
// sim/littlefield/calibrate.py; test/sim.mjs checks it against Python.

import { simulate, policy, startState, pyRound } from './model.js';
import { daily, configFromSnapshot } from './snapshot.js';
import { Rng } from './rng.js';
import { pct } from './analysis.js';

// Arrival times that reproduce the real daily accepted counts, spread at random within each day.
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

// The reorder point in force when each past kit order fired, estimated from stock levels.
export function orderRops(real, kitLead = 4, startKits = 9600) {
  const onHand = (i) => {
    const d = real[i];
    let onOrder = 0;
    for (const x of real.slice(0, i + 1)) if (x.kitsOrdered && x.day > d.day - kitLead) onOrder += x.kitsOrdered;
    return d.kitPosition - onOrder;
  };
  const out = {};
  real.forEach((d, i) => {
    if (!d.kitsOrdered) return;
    const before = i > 0 ? onHand(i - 1) : startKits;
    const after = Math.max(0, onHand(i));
    out[d.day] = Math.max(0, Math.trunc(pyRound((Math.max(before, after) + after) / 2)));
  });
  return out;
}

// What the team actually did: machine counts, contracts and kit order days.
export function historyPolicy(real) {
  const placedOrders = {};
  for (const d of real) if (d.kitsOrdered) placedOrders[d.day] = Math.trunc(d.kitsOrdered);
  const pol = policy({ placedOrders, placedRop: orderRops(real) });
  let prevM = null, prevC = null;
  for (const d of real) {
    const m = d.machines.map((x) => Math.max(1, Math.ceil(pyRound(x, 3))));
    if (!prevM || m.join() !== prevM.join()) { pol.machines[d.day] = m; prevM = m; }
    if (d.contract && d.contract !== prevC) { pol.contract[d.day] = d.contract; prevC = d.contract; }
  }
  return pol;
}

export function changed(real) {
  const pol = historyPolicy(real);
  return Object.keys(pol.machines).length > 1 || Object.keys(pol.contract).length > 1;
}

// Run the real arrivals through the model `runs` times.
export function replay(snap, cfg, { runs = 20, seed = 1 } = {}) {
  const real = daily(snap);
  let pol, start;
  if (changed(real)) {
    pol = historyPolicy(real);
    const m1 = pol.machines[real[0].day];
    delete pol.machines[real[0].day];
    start = startState({ machines: m1 || [2, 3, 2], rop: 0, qty: 0 });
  } else {
    pol = policy();
    start = startState();
  }
  const out = [];
  for (let k = 0; k < runs; k++) {
    const arrivals = replayArrivals(real, new Rng(10000 + seed + k));
    out.push(simulate({ cfg, pol, start, seed: seed + k, arrivals }));
  }
  return { real, runs: out };
}

// Real against simulated revenue per job and lead time over chosen days (default: the
// days the $1,250 contract took orders), with the spread across runs.
export function contractPeriod(real, runs, { contract = 3, from = null, to = null } = {}) {
  const idx = [];
  real.forEach((d, i) => {
    if (!d.completed) return;
    if (from !== null ? d.day >= from && d.day <= to : d.contract === contract) idx.push(i);
  });
  if (!idx.length) return null;
  let doneReal = 0, revReal = 0, leadReal = 0;
  for (const i of idx) { doneReal += real[i].completed; revReal += real[i].revenue; leadReal += real[i].lead * real[i].completed; }
  const perRun = runs.map((r) => {
    let rev = 0, done = 0, lead = 0;
    for (const i of idx) { rev += r.days[i].revenue; done += r.days[i].completed; for (const x of r.days[i].leads) lead += x; }
    return { rev: rev / done, lead: lead / done };
  });
  let rev = 0, done = 0, lead = 0;
  for (const r of runs) for (const i of idx) { rev += r.days[i].revenue; done += r.days[i].completed; for (const x of r.days[i].leads) lead += x; }
  const revs = perRun.map((p) => p.rev);
  return {
    days: idx.map((i) => real[i].day),
    revReal: revReal / doneReal, revSim: rev / done, revP10: pct(revs, 0.1), revP90: pct(revs, 0.9),
    revPercentile: revs.filter((v) => v < revReal / doneReal).length / revs.length,
    leadReal: leadReal / doneReal, leadSim: lead / done,
  };
}

// The model's parameter sets over the game, in the order they were adopted.
export const VERSIONS = [
  { id: 'v1', label: 'Day 50 fit', adopted: 'Fitted on the congested Days 1-50', cv: [0.0, 0.75, 1.0], step2Share: 0.5 },
  { id: 'v2', label: 'Day 78 correction', adopted: 'Revenue per job ran $43 low on the $1,250 contract', cv: [0.0, 0.25, 1.0], step2Share: 0.5 },
  { id: 'v3', label: 'Lots ruled out', adopted: 'One lot of 60 kits per job; Station 2 step split refitted', cv: [0.0, 0.25, 1.0], step2Share: 0.3 },
  { id: 'v4', label: 'Day 198 refit', adopted: '138 post-restart days; model had run $16 a job low', cv: [0.0, 0.5, 0.75], step2Share: 0.3 },
];

// Each version replayed against one extract: the $1,250-contract period as a whole, and in
// 20-day blocks for the current version and the first.
export function drift(snap, { runs = 20 } = {}) {
  const real = daily(snap);
  const c3 = real.filter((d) => d.contract === 3 && d.completed);
  if (!c3.length) return { day: real[real.length - 1].day, versions: [], blocks: [], note: 'No days on the $1,250 contract in this extract yet.' };
  const first = c3[0].day, last = c3[c3.length - 1].day;
  const blocks = [];
  for (let a = first; a <= last; a += 20) blocks.push([a, Math.min(a + 19, last)]);
  const versions = VERSIONS.map((v) => {
    const cfg = configFromSnapshot(snap, { cv: v.cv, step2Share: v.step2Share });
    const { runs: out } = replay(snap, cfg, { runs });
    const whole = contractPeriod(real, out);
    const byBlock = blocks.map(([a, b]) => contractPeriod(real, out, { from: a, to: b }));
    return { ...v, whole, byBlock };
  });
  return { day: real[real.length - 1].day, first, last, blocks, versions };
}
