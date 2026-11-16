// The questions the dashboard asks of the model. Port of sim/littlefield/analysis.py.

import { simulate, policy, startState, revenueFor, PRIORITY_STEP4, ROUTE, visitTime } from './model.js';

export const MIXES = [[2, 3, 2], [2, 3, 3], [3, 3, 3], [2, 4, 3], [3, 4, 3], [3, 4, 4], [3, 5, 3], [4, 5, 4]];

export function pct(xs, p) {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const k = (s.length - 1) * p;
  const lo = Math.floor(k), hi = Math.ceil(k);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

const mean = (xs) => (xs.length ? xs.reduce((t, v) => t + v, 0) / xs.length : null);

export function pureTime(cfg) {
  let t = 0;
  for (let s = 0; s < ROUTE.length; s++) t += visitTime(cfg, s);
  return t;
}

// Lead times for a machine mix with kits never short and demand held constant.
export function steady(cfg, mix, { demand = 15.5, schedule = PRIORITY_STEP4, runs = 20, warmup = 20, days = 60, seed = 1 } = {}) {
  const c = { ...cfg, gameEnd: warmup + days, controlEnd: warmup + days };
  const start = startState({ day: 0, cash: 1e12, machines: mix, kits: 1e9, rop: 0, qty: 0, schedule });
  const leads = [], util = [[], [], []];
  let rejected = 0, done = 0;
  for (let k = 0; k < runs; k++) {
    const r = simulate({ cfg: c, pol: policy(), start, seed: seed + k, demand });
    for (const d of r.days.slice(warmup)) {
      for (const x of d.leads) leads.push(x);
      rejected += d.rejected; done += d.completed;
      for (let s = 0; s < 3; s++) util[s].push(d.util[s]);
    }
  }
  const out = {
    mix, demand, leadMean: mean(leads), leadP90: pct(leads, 0.9), util: util.map(mean),
    rejectedPerDay: rejected / (runs * days), jobsPerDay: done / (runs * days),
  };
  for (const n of [1, 2, 3]) {
    let t = 0;
    for (const x of leads) t += revenueFor(cfg.contracts[n], x);
    out['rev' + n] = leads.length ? t / leads.length : null;
  }
  return out;
}

// Visual 2: lead time against bottleneck utilization, demand 8 to 20 jobs a day.
export function sweep(cfg, mix, { demands = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], schedule = PRIORITY_STEP4, runs = 8 } = {}) {
  return demands.map((lam) => {
    const r = steady(cfg, mix, { demand: lam, schedule, runs, days: 40 });
    r.bottleneck = Math.max(...r.util);
    r.mmc = mmcLead(cfg, mix, lam);
    return r;
  });
}

// M/M/c mean wait in queue (days); null if the station is overloaded.
export function erlangCWait(lam, mu, c) {
  const a = lam / mu, rho = a / c;
  if (rho >= 1) return null;
  let s = 0, f = 1;
  for (let k = 0; k < c; k++) { if (k > 0) f *= k; s += a ** k / f; }
  const fc = f * c;
  const top = a ** c / fc / (1 - rho);
  return (top / (s + top)) / (c * mu - lam);
}

// Lead time if every station were M/M/c: the textbook line, an upper bound here.
export function mmcLead(cfg, mix, lam) {
  let total = 0;
  for (let s = 0; s < 3; s++) {
    const visits = s === 1 ? 2 : 1;
    const per = cfg.ptimes[s] / visits;
    const w = erlangCWait(lam * visits, 1 / per, mix[s]);
    if (w === null) return null;
    total += visits * (w + per);
  }
  return total;
}

// The dashboard's preset lines, starting from `start`.
export function presets(start, { rop = 6000, qty = 26700, finalDay = null } = {}) {
  const d = start.day + 1;
  const plan = (top) => policy({
    machines: { [d]: [3, 4, 3] }, rop: { [d]: rop }, qty: { [d]: qty }, schedule: { [d]: PRIORITY_STEP4 },
    ladder: true, ladderTop: top, finalDay,
  });
  return {
    'Do nothing': policy({ finalDay: null }),
    'Safe (3/4/3, up to $1,000)': plan(2),
    'Recommended (3/4/3, up to $1,250)': plan(3),
  };
}

// Median and 10th-90th percentile cash by day, Day 268 cash, and when contracts switched.
// Every policy uses the same seeds, so differences between policies are not demand noise.
export function project(start, cfg, pol, { demand = 15.5, runs = 200, seed = 1 } = {}) {
  const res = [];
  for (let k = 0; k < runs; k++) res.push(simulate({ cfg, pol, start, seed: seed + k, demand }));
  const n = Math.min(...res.map((r) => r.days.length));
  const byDay = [];
  for (let i = 0; i < n; i++) {
    const cash = res.map((r) => r.days[i].cash);
    const lead = res.map((r) => r.days[i].lead);
    byDay.push({ day: res[0].days[i].day, p10: pct(cash, 0.1), p50: pct(cash, 0.5), p90: pct(cash, 0.9), lead50: pct(lead, 0.5) });
  }
  const final = res.map((r) => r.finalCash);
  const switches = { 2: [], 3: [] };
  for (const r of res) {
    let prev = start.contract; const seen = {};
    for (const d of r.days) if (d.contract !== prev) { if (!(d.contract in seen)) seen[d.contract] = d.day; prev = d.contract; }
    for (const c of [2, 3]) if (c in seen) switches[c].push(seen[c]);
  }
  const revs = res.map((r) => { let rev = 0, done = 0; for (const d of r.days) { rev += d.revenue; done += d.completed; } return done ? rev / done : null; });
  return {
    byDay, finalP10: pct(final, 0.1), finalP50: pct(final, 0.5), finalP90: pct(final, 0.9),
    kitsLeftP50: pct(res.map((r) => r.kitsLeft), 0.5), revPerJob: pct(revs, 0.5),
    blocked: res.filter((r) => r.blocked.length).length / runs,
    switchDay: { 2: pct(switches[2], 0.5), 3: pct(switches[3], 0.5) },
    switchRuns: { 2: switches[2].length / runs, 3: switches[3].length / runs },
  };
}

// For each candidate day: does the final order go through, its size, and what it leaves.
export function finalOrder(start, cfg, basePolicy, { days, demand = 15.5, runs = 40, seed = 1 } = {}) {
  return days.map((day) => {
    const pol = { ...basePolicy, finalDay: day, finalQty: null };
    let fired = 0;
    const sizes = [], when = [], left = [], cash = [], waiting = [];
    for (let k = 0; k < runs; k++) {
      const r = simulate({ cfg, pol, start, seed: seed + k, demand });
      const fin = r.orders.filter(([t]) => t >= day - 1);
      if (fin.length) { fired++; sizes.push(fin[0][1]); when.push(fin[0][0]); }
      left.push(r.kitsLeft); cash.push(r.finalCash);
      waiting.push(r.days.filter((d) => d.day > day).reduce((t, d) => t + d.waiting, 0));
    }
    const size = pct(sizes, 0.5);
    return {
      day, fires: fired / runs, size, cost: size === null ? null : size * cfg.kitCost + cfg.orderFee,
      placed: pct(when, 0.5), kitsLeft: pct(left, 0.5), jobDaysWaiting: pct(waiting, 0.5),
      finalCashP50: pct(cash, 0.5), finalCashP10: pct(cash, 0.1),
    };
  });
}

export const FINAL_ORDER_STEPS = [
  'Check in Littlefield that no kit order is on the way. If one is, wait for it to arrive: an order cannot be placed while another is in transit.',
  'Check cash is at least (order size × $10) + $1,000. If not, the order will not be placed: wait, or reduce the size.',
  'Set the order quantity to the final order size.',
  'Raise the reorder point above current inventory (for example 999,999) so the order fires at once.',
  'Within the hour, once the order shows as placed, set the order quantity to 0 so no further order is made.',
];
