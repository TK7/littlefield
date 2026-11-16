// Background thread for the what-if simulator, so the page stays responsive.
// Messages in:  {id, type: 'init', snap} | {id, type: 'whatif', settings} | {id, type: 'final', settings}
// Messages out: {id, type, result} or {id, type, error}

import { policy } from './model.js';
import { startFromSnapshot, configFromSnapshot, daily, recentDemand } from './snapshot.js';
import { project, presets, sweep, steady, finalOrder, mmcLead, FINAL_ORDER_STEPS } from './analysis.js';

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
    const demand = recentDemand(days);
    ctx = { cfg, start, demand };
    const lines = {};
    if (start.day < cfg.gameEnd) {
      for (const [name, pol] of Object.entries(presets(start, { finalDay: Math.max(210, start.day + 1) }))) {
        lines[name] = lineSummary(project(start, cfg, pol, { demand, runs }));
      }
    }
    return {
      demand, ptimes: cfg.ptimes, cv: cfg.cv, start: { ...start, jobs: start.jobs.length },
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

  final({ settings, runs = 30 }) {
    const { cfg, start } = ctx;
    const demand = settings.demand || ctx.demand;
    const first = Math.max(193, start.day + 1);
    const last = cfg.controlEnd - 1;
    const days = [];
    for (let d = first; d <= last; d += 4) days.push(d);
    if (days.length && days[days.length - 1] !== last) days.push(last);
    const rows = first <= last ? finalOrder(start, cfg, { ...policyFrom(start, settings), finalDay: null }, { days, demand, runs }) : [];
    return { rows, steps: FINAL_ORDER_STEPS, first, last };
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
