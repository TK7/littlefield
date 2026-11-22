// Background thread for the what-if simulator, so the page stays responsive.
// Messages in:  {id, type: 'init', snap} | {id, type: 'whatif', settings} | {id, type: 'final', settings}
// Messages out: {id, type, result} or {id, type, error}

import { policy } from './model.js';
import { startFromSnapshot, configFromSnapshot, daily, recentDemand } from './snapshot.js';
import { project, presets, sweep, steady, finalOrder, mmcLead, pct, FINAL_ORDER_STEPS } from './analysis.js';
import { simulate } from './model.js';
import { drift } from './calibrate.js';

let ctx = null; // { cfg, start, demand }

// Deck settings -> a policy applied from the day after the snapshot.
export function policyFrom(start, s) {
  const d = start.day + 1;
  return policy({
    machines: { [d]: s.machines }, schedule: { [d]: s.schedule }, rop: { [d]: s.rop }, qty: { [d]: s.qty },
    contract: s.ladder ? {} : { [d]: s.contract }, ladder: !!s.ladder, ladderTop: s.ladder ? s.contract : 3,
    finalDay: s.finalDay || null,
  });
}

function lineSummary(p) {
  return {
    byDay: p.byDay, finalP10: p.finalP10, finalP50: p.finalP50, finalP90: p.finalP90,
    kitsLeft: p.kitsLeftP50, revPerJob: p.revPerJob, switchDay: p.switchDay, switchRuns: p.switchRuns, blocked: p.blocked,
  };
}

const handlers = {
  init({ snap, runs = 200 }) {
    const cfg = configFromSnapshot(snap);
    const start = startFromSnapshot(snap);
    const days = daily(snap);
    // Planning demand from the Settings tab (B15) when set: the team's expectation for the
    // rest of the game. Recent demand is shown alongside but does not drive projections.
    const recent = recentDemand(days);
    const plan = Number(snap.settings && snap.settings.demandPlan) || 0;
    const demand = plan > 0 ? plan : recent;
    // The order quantity Littlefield actually used last, from cash; the Settings tab can lag.
    const lastOrder = days.filter((d) => d.kitsOrdered).at(-1) || null;
    ctx = { cfg, start, demand };
    const lines = {};
    if (start.day < cfg.gameEnd) {
      for (const [name, pol] of Object.entries(presets(start, { finalDay: Math.max(210, start.day + 1) }))) {
        lines[name] = lineSummary(project(start, cfg, pol, { demand, runs }));
      }
    }
    return {
      demand, demandSource: plan > 0 ? 'plan' : 'recent', recentDemand: recent,
      lastOrder: lastOrder && { day: lastOrder.day, kits: lastOrder.kitsOrdered },
      ptimes: cfg.ptimes, cv: cfg.cv, start: { ...start, jobs: start.jobs.length },
      waiting: start.jobs.filter((j) => j[2] === 'kits').length, lines,
    };
  },

  whatif({ settings, runs = 200 }) {
    const { cfg, start } = ctx;
    const demand = settings.demand || ctx.demand;
    const pol = policyFrom(start, settings);
    const line = start.day < cfg.gameEnd ? lineSummary(project(start, cfg, pol, { demand, runs })) : null;
    const mix = settings.machines;
    const curve = sweep(cfg, mix, { schedule: settings.schedule });
    const here = steady(cfg, mix, { demand, schedule: settings.schedule, runs: 12 });
    here.bottleneck = Math.max(...here.util);
    here.mmc = mmcLead(cfg, mix, demand);
    return { demand, line, curve, here };
  },

  // Contract readiness at the given settings: expected revenue per job for a new order
  // on each contract, from the simulated lead-time distribution (kits never short).
  readiness({ settings }) {
    const { cfg } = ctx;
    const demand = settings.demand || ctx.demand;
    const r = steady(cfg, settings.machines, { demand, schedule: settings.schedule, runs: 16 });
    return {
      machines: settings.machines, schedule: settings.schedule, demand,
      leadMean: r.leadMean, leadP90: r.leadP90, busiest: Math.max(...r.util),
      revenuePerJob: { 'Contract 1 ($750)': r.rev1, 'Contract 2 ($1,000)': r.rev2, 'Contract 3 ($1,250)': r.rev3 },
    };
  },

  // How each version of the model's calibration compares with this extract's real days.
  drift({ snap, runs = 16 }) {
    return drift(snap, { runs });
  },

  // Final order size: Day 268 cash for sizes around the model's own, placed on `day`.
  sizeSweep({ settings, day, runs = 150 }) {
    const { cfg, start } = ctx;
    const demand = settings.demand || ctx.demand;
    const base = { ...policyFrom(start, settings), finalDay: day, finalQty: null };
    const auto = simulate({ cfg, pol: base, start, seed: 1, demand }).orders.find(([t]) => t >= day - 1);
    if (!auto) return { day, rows: [] };
    const centre = Math.round(auto[1] / 60);
    const rows = [];
    for (const b of [-18, -12, -8, -4, -2, 0, 2, 4, 8, 12, 18]) {
      const kits = (centre + b) * 60;
      if (kits <= 0) continue;
      const cash = [];
      let short = 0;
      for (let k = 0; k < runs; k++) {
        const r = simulate({ cfg, pol: { ...base, finalQty: kits }, start, seed: 7000 + k, demand });
        cash.push(r.finalCash);
        if (r.days.some((d) => d.day > cfg.gameEnd - 13 && d.waiting > 0.5)) short++;
      }
      rows.push({ batches: centre + b, kits, cost: kits * cfg.kitCost + cfg.orderFee,
        mean: cash.reduce((t, v) => t + v, 0) / runs, p10: pct(cash, 0.1), p50: pct(cash, 0.5), shortShare: short / runs });
    }
    const best = Math.max(...rows.map((r) => r.mean));
    rows.forEach((r) => { r.vsBest = r.mean - best; });
    return { day, demand, modelBatches: centre, rows };
  },

  final({ settings, runs }) {
    const { cfg, start } = ctx;
    const demand = settings.demand || ctx.demand;
    const first = Math.max(193, start.day + 1);
    const last = cfg.controlEnd - 1;
    // Every day once the window is close (more runs, so neighbouring days compare fairly);
    // every fourth day while it is far off.
    const near = last - first <= 24;
    const step = near ? 1 : 4;
    const n = runs || (near ? 60 : 30);
    const days = [];
    for (let d = first; d <= last; d += step) days.push(d);
    if (days.length && days[days.length - 1] !== last) days.push(last);
    const base = { ...policyFrom(start, settings), finalDay: null };
    const rows = first <= last ? finalOrder(start, cfg, base, { days, demand, runs: n }) : [];
    // When Littlefield's own reorder rule would place the next order if nothing changes.
    const next = [];
    for (let k = 0; k < n; k++) {
      const r = simulate({ cfg, pol: base, start, seed: 1 + k, demand });
      const o = r.orders.find(([t]) => t >= start.day);
      if (o) next.push(o);
    }
    const nextRegular = next.length ? { day: Math.ceil(pct(next.map((o) => o[0]), 0.5)), kits: next[0][1], share: next.length / n,
      beforeControlEnds: next.filter((o) => o[0] < cfg.controlEnd).length / n } : null;
    return { rows, steps: FINAL_ORDER_STEPS, first, last, demand, nextRegular,
      sizeRule: { kitsPerDay: demand * cfg.kitsPerJob, until: cfg.gameEnd - (cfg.ptimes[0] + cfg.ptimes[1] + cfg.ptimes[2]) } };
  },
};

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof window === 'undefined') {
  self.addEventListener('message', (e) => {
    const { id, type } = e.data;
    try {
      self.postMessage({ id, type, result: handlers[type](e.data) });
    } catch (err) {
      self.postMessage({ id, type, error: String(err && err.message || err) });
    }
  });
}

export { handlers };
