// Snapshot (the JSON the Google Sheet pushes) -> simulation inputs.
// Port of sim/littlefield/snapshot.py.

import { configFromSettings, startState, pyRound, SCHEDULES, FIFO } from './model.js';

const DAY = 0, WAITING = 1, ACC = [2, 3, 4];
const Q = [5, 8, 11], U = [6, 9, 12], M = [7, 10, 13];
const OUT = [14, 15, 16], REV = [17, 18, 19], LEAD = [20, 21, 22], CASH = 23;

const ceil3 = (x) => Math.ceil(pyRound(x, 3));
const floor3 = (x) => Math.floor(pyRound(x, 3));
const sum = (xs) => xs.reduce((t, v) => t + v, 0);

// Per-day facts from the raw rows, with kit orders inferred from cash like the Sheet does.
export function daily(snap) {
  const s = snap.settings || {};
  const cfg = configFromSettings(s);
  const startCash = s.startCash || 1_000_000;
  const startKits = s.startKits || 9600;
  const threshold = s.kitThreshold || 20000;
  const stations = s.stations && s.stations.length === 3 ? s.stations : [{}, {}, {}];
  const starts = stations.map((st, k) => st.start || [2, 3, 2][k]);
  const rows = snap.raw.slice().sort((a, b) => a[DAY] - b[DAY]);
  const out = [];
  let prevCash = startCash, prevM = starts, prevContract = null, cumAcc = 0, cumOrdered = 0;
  for (const r of rows) {
    const accepted = sum(ACC.map((i) => r[i]));
    const completed = sum(OUT.map((i) => r[i]));
    const revenue = sum(OUT.map((o, k) => r[o] * r[REV[k]]));
    const leadSum = sum(OUT.map((o, k) => r[o] * r[LEAD[k]]));
    const cash = r[CASH] * 1000;
    const mach = M.map((i) => r[i]);
    let contract = prevContract;
    if (accepted > 0) {
      let best = 0;
      for (let k = 1; k < 3; k++) if (r[ACC[k]] > r[ACC[best]]) best = k;
      contract = best + 1;
    }
    const spend = prevCash * (1 + cfg.dailyRate) + revenue - cash;
    let machineSpend = 0;
    for (let k = 0; k < 3; k++) {
      const bought = Math.max(0, ceil3(mach[k]) - ceil3(prevM[k]));
      const sold = Math.max(0, floor3(prevM[k]) - floor3(mach[k]));
      machineSpend += bought * cfg.prices[k] - sold * cfg.resale;
    }
    const kitSpend = spend - machineSpend;
    let ordered = 0;
    if (kitSpend > threshold) ordered = Math.trunc(pyRound((kitSpend - cfg.orderFee) / cfg.kitCost / 10) * 10);
    cumAcc += accepted;
    cumOrdered += ordered;
    out.push({
      day: Math.trunc(r[DAY]), accepted, completed, revenue,
      lead: completed ? leadSum / completed : null, waiting: r[WAITING],
      queueKits: Q.map((i) => r[i]), util: U.map((i) => r[i]), machines: mach,
      cash, contract, kitsOrdered: ordered,
      kitPosition: startKits + cumOrdered - cfg.kitsPerJob * cumAcc, cumAccepted: cumAcc, wip: null,
    });
    prevCash = cash; prevM = mach; prevContract = contract;
  }
  let done = 0;
  for (const d of out) { done += d.completed; d.wip = d.cumAccepted - done; }
  return out;
}

export function scheduleRule(text) {
  const t = String(text || '').trim().toLowerCase();
  const exact = SCHEDULES.find((r) => r.toLowerCase() === t);
  if (exact) return exact;
  if (t.includes('4')) return SCHEDULES[2];
  if (t.includes('2')) return SCHEDULES[1];
  return FIFO;
}

export function recentDemand(days, n = 14) {
  const last = days.slice(-n);
  return sum(last.map((d) => d.accepted)) / Math.min(n, days.length);
}

// Estimated factory state at the end of the latest day (see snapshot.py for the method).
export function startFromSnapshot(snap, demand = null) {
  const days = daily(snap);
  const s = snap.settings || {};
  const cfg = configFromSettings(s);
  const last = days[days.length - 1];
  const day = last.day;
  const rate = demand || recentDemand(days);

  const recent = days.filter((d) => d.kitsOrdered && d.day > day - cfg.kitLead);
  const onOrder = sum(recent.map((d) => d.kitsOrdered));
  const position = last.kitPosition;
  const kits = Math.max(0, position - onOrder);
  const waitingJobs = position < onOrder ? Math.max(0, pyRound((onOrder - position) / cfg.kitsPerJob)) : 0;
  const orderArrives = recent.length ? recent[recent.length - 1].day - 0.5 + cfg.kitLead : null;

  const machines = last.machines.map((m) => Math.max(1, pyRound(m)));
  const inStations = Math.max(0, Math.trunc(last.wip) - waitingJobs);
  const weight = [0, 1, 2].map((k) => last.queueKits[k] / cfg.kitsPerJob + machines[k] * last.util[k]);
  const total = sum(weight) || 1;
  const per = weight.map((w) => Math.trunc(pyRound(inStations * w / total)));
  per[0] += inStations - sum(per);

  const placed = [];
  const half = Math.floor(per[1] / 2);
  for (let i = 0; i < half; i++) placed.push(3);
  for (let i = 0; i < per[2]; i++) placed.push(2);
  for (let i = 0; i < per[1] - half; i++) placed.push(1);
  for (let i = 0; i < per[0]; i++) placed.push(0);
  for (let i = 0; i < waitingJobs; i++) placed.push('kits');
  const n = placed.length;
  const contract = last.contract || 1;
  const jobs = placed.map((where, i) => [day - (n - i) / rate, contract, where]);

  return startState({
    day, cash: last.cash, machines, kits: Math.trunc(kits),
    orderArrives, orderQty: recent.length ? Math.trunc(onOrder) : 0,
    contract, rop: Math.trunc(s.rop || 0), qty: Math.trunc(s.q || 0), schedule: scheduleRule(s.sched), jobs,
  });
}

// Machine-days per job at each station, measured from utilization (see snapshot.py).
export function measuredPtimes(snap) {
  const days = daily(snap);
  const st = startFromSnapshot(snap);
  const done = sum(days.map((d) => d.completed));
  const steps = st.jobs.map((j) => j[2]).filter((w) => w !== 'kits');
  const past = [1, 2, 3].map((k) => steps.filter((w) => w >= k).length);
  const busy = [0, 1, 2].map((k) => sum(days.map((d) => d.util[k] * d.machines[k])));
  const jobs = [done + past[0], done + past[1] * 0.5, done + past[2]];
  return [0, 1, 2].map((k) => (jobs[k] ? pyRound(busy[k] / jobs[k], 4) : null));
}

// Model settings from the snapshot, with process times measured from the data.
export function configFromSnapshot(snap, overrides = {}) {
  const cfg = configFromSettings(snap.settings || {});
  if (!('ptimes' in overrides)) {
    const m = measuredPtimes(snap);
    if (m.every((x) => x)) overrides = { ...overrides, ptimes: m };
  }
  return { ...cfg, ...overrides };
}
