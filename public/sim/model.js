// Event simulation of the Littlefield factory.
// A line-by-line port of sim/littlefield/model.py, the reference model calibrated on the
// real game. Keep the two in step: test/sim.mjs checks this file against results from
// the Python model (test/fixtures/sim-golden.json).
//
// Time is in days. Day d is the interval (d-1, d]; its numbers are booked at time d.
// Route: Station 1 -> Station 2 (step 2) -> Station 3 -> Station 2 (step 4).
// Kits are ordered when all four Littlefield conditions hold: kits on hand <= reorder
// point, no order on the way, cash >= one order's cost, order quantity > 0.

import { Rng } from './rng.js';

export const FIFO = 'FIFO';
export const PRIORITY_STEP2 = 'Prioritize Step 2';
export const PRIORITY_STEP4 = 'Prioritize Step 4';
export const SCHEDULES = [FIFO, PRIORITY_STEP2, PRIORITY_STEP4];
export const ROUTE = [0, 1, 2, 1];

// Python's round(): halves go to the even neighbour. Used where the Python model rounds.
export function pyRound(x, digits = 0) {
  const m = 10 ** digits;
  const y = x * m;
  const f = Math.floor(y);
  const diff = y - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return r / m;
}

export function defaultConfig() {
  return {
    kitsPerJob: 60, kitCost: 10, orderFee: 1000, kitLead: 4,
    dailyRate: 1.1 ** (1 / 365) - 1, wipLimit: 100, controlEnd: 218, gameEnd: 268, resale: 10000,
    prices: [90000, 80000, 100000],
    ptimes: [0.1171, 0.1749, 0.1226],   // measured on Days 1-50
    step2Share: 0.5,
    cv: [0.0, 0.75, 1.0],                // fitted on Days 1-50
    contracts: { 1: [750, 7, 14], 2: [1000, 1, 3], 3: [1250, 0.5, 1] },
  };
}

export function visitTime(cfg, step) {
  const st = ROUTE[step];
  if (st === 1) return cfg.ptimes[1] * (step === 1 ? cfg.step2Share : 1 - cfg.step2Share);
  return cfg.ptimes[st];
}

export function configFromSettings(s = {}, overrides = {}) {
  const base = defaultConfig();
  const pick = (key, d) => (typeof s[key] === 'number' && Number.isFinite(s[key]) && s[key] !== 0 ? s[key] : d);
  const cfg = {
    ...base,
    kitsPerJob: Math.trunc(pick('kitsPerJob', base.kitsPerJob)), kitCost: pick('kitCost', base.kitCost),
    orderFee: pick('orderFee', base.orderFee), kitLead: pick('kitLead', base.kitLead),
    dailyRate: pick('dailyRate', base.dailyRate), wipLimit: Math.trunc(pick('wipLimit', base.wipLimit)),
    controlEnd: Math.trunc(pick('controlEnd', base.controlEnd)), gameEnd: Math.trunc(pick('gameEnd', base.gameEnd)),
    resale: pick('resale', base.resale),
  };
  const st = s.stations || [];
  if (st.length === 3 && st.every((x) => x.price)) cfg.prices = st.map((x) => Number(x.price));
  if (st.length === 3 && st.every((x) => x.ptime)) cfg.ptimes = st.map((x) => Number(x.ptime));
  const cs = s.contracts || [];
  if (cs.length === 3 && cs.every((c) => c.revenue)) {
    cfg.contracts = { 1: null, 2: null, 3: null };
    cs.forEach((c, k) => { cfg.contracts[k + 1] = [Number(c.revenue), Number(c.quoted), Number(c.max)]; });
  }
  return { ...cfg, ...overrides };
}

// Revenue for one job: full up to the quoted time, falling linearly to 0 at the maximum.
export function revenueFor(contract, lead) {
  const [rev, quoted, maximum] = contract;
  if (lead <= quoted) return rev;
  if (lead >= maximum) return 0;
  return rev * (maximum - lead) / (maximum - quoted);
}

// The team's settings over time: each map is day -> value from the start of that day.
export function policy(p = {}) {
  return {
    machines: {}, contract: {}, rop: {}, qty: {}, schedule: {},
    ladder: false, ladderTop: 3, ladderMargin: 0.25,
    finalDay: null, finalQty: null,
    placedOrders: {}, placedRop: 0,
    ...p,
  };
}

// Factory state at the end of `day`. jobs: [acceptedTime, contract, where], where = 'kits' or a step 0..3.
export function startState(s = {}) {
  return {
    day: 0, cash: 1_000_000, machines: [2, 3, 2], kits: 9600,
    orderArrives: null, orderQty: 0, contract: 1, rop: 1440, qty: 7200, schedule: FIFO, jobs: [],
    ...s,
  };
}

// Event kinds, ordered so simultaneous events resolve the same way as in Python.
const DAY = 0, KITS = 1, FINISH = 2, ARRIVAL = 3, PLACE = 4;

// Binary heap ordered by (time, kind, seq), like Python's heapq on tuples.
class Heap {
  constructor() { this.a = []; }
  get length() { return this.a.length; }
  static less(x, y) { return x.t < y.t || (x.t === y.t && (x.kind < y.kind || (x.kind === y.kind && x.seq < y.seq))); }
  push(e) {
    const a = this.a; a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

class Sim {
  constructor(cfg, pol, start, rng, demand, arrivals) {
    this.cfg = cfg; this.pol = pol; this.rng = rng;
    this.demand = demand; this.arrivals = arrivals;
    this.t = start.day;
    this.cash = start.cash; this.prevClose = start.cash;
    this.machines = start.machines.slice();
    this.busy = [0, 0, 0];
    this.queue = [[], [], []];
    this.kits = start.kits;
    this.inTransit = start.orderArrives !== null && start.orderArrives !== undefined;
    this.contract = start.contract;
    this.rop = start.rop; this.qty = start.qty; this.schedule = start.schedule;
    this.finalPending = false;
    this.forced = null;
    this.waiting = [];
    this.wip = 0;
    this.events = new Heap(); this.seq = 0;
    this.orders = []; this.purchases = []; this.blocked = []; this.days = [];
    this.resetDay();
    this.last = this.t;
    if (this.inTransit) this.push(start.orderArrives, KITS, start.orderQty);
    const jobs = start.jobs.slice().sort((x, y) => x[0] - y[0]);
    for (const [accepted, contract, where] of jobs) {
      const job = { accepted, contract, step: 0, queued: 0 };
      this.wip += 1;
      if (where === 'kits') this.waiting.push(job);
      else { job.step = where; this.enqueue(job); }
    }
    for (let s = 0; s < 3; s++) this.dispatch(s);
    if (start.day < cfg.controlEnd) this.applyPolicy(start.day + 1);
    if (this.arrivals === null) this.nextArrival();
    else for (const a of this.arrivals) if (a > this.t) this.push(a, ARRIVAL, null);
    this.push(start.day + 1, DAY, start.day + 1);
    for (const [dayKey, kits] of Object.entries(pol.placedOrders)) {
      const day = Number(dayKey);
      if (day - 1 >= this.t) {
        this.push(day - 1 + 1e-6, PLACE, [day, kits, 'open']);
        this.push(day - 1e-6, PLACE, [day, kits, 'close']);
      }
    }
  }

  push(t, kind, data) { this.seq += 1; this.events.push({ t, kind, seq: this.seq, data }); }
  rate(day) { return typeof this.demand === 'function' ? this.demand(day) : this.demand; }

  nextArrival() {
    const day = Math.floor(this.t) + 1;
    const rate = this.rate(day);
    if (rate > 0) this.push(this.t + this.rng.exponential(rate), ARRIVAL, null);
    else this.push(day, ARRIVAL, 'skip');
  }

  resetDay() {
    this.dAcc = 0; this.dRej = 0; this.dDone = 0;
    this.dRev = 0; this.dLead = 0; this.dWait = 0;
    this.dQ = [0, 0, 0]; this.dBusy = [0, 0, 0]; this.dMach = [0, 0, 0];
    this.dLeads = [];
  }

  advance(t) {
    const dt = t - this.last;
    if (dt > 0) {
      this.dWait += dt * this.waiting.length;
      for (let s = 0; s < 3; s++) {
        this.dQ[s] += dt * this.queue[s].length;
        this.dBusy[s] += dt * Math.min(this.busy[s], this.machines[s]);
        this.dMach[s] += dt * this.machines[s];
      }
    }
    this.last = t; this.t = t;
  }

  enqueue(job) { job.queued = this.t; this.queue[ROUTE[job.step]].push(job); }

  pick(s) {
    const q = this.queue[s];
    if (s === 1 && this.schedule !== FIFO) {
      const want = this.schedule === PRIORITY_STEP2 ? 1 : 3;
      for (let i = 0; i < q.length; i++) if (q[i].step === want) return q.splice(i, 1)[0];
    }
    return q.shift();
  }

  dispatch(s) {
    while (this.busy[s] < this.machines[s] && this.queue[s].length) {
      const job = this.pick(s);
      this.busy[s] += 1;
      this.push(this.t + this.rng.process(visitTime(this.cfg, job.step), this.cfg.cv[s]), FINISH, [s, job]);
    }
  }

  orderCost(q) { return q * this.cfg.kitCost + this.cfg.orderFee; }

  place(kits) {
    this.cash -= this.orderCost(kits);
    this.inTransit = true;
    this.orders.push([this.t, kits]);
    this.push(this.t + this.cfg.kitLead, KITS, kits);
  }

  checkForced() {
    if (this.forced && this.kits <= this.pol.placedRop) { this.place(this.forced[1]); this.forced = null; }
  }

  checkOrder() {
    if (this.forced !== null) this.checkForced();
    if (this.inTransit || this.qty <= 0 || this.kits > this.rop) return;
    const cost = this.orderCost(this.qty);
    if (this.cash < cost) return;
    this.cash -= cost;
    this.inTransit = true;
    this.orders.push([this.t, this.qty]);
    this.push(this.t + this.cfg.kitLead, KITS, this.qty);
    // The final order went through: the team sets the quantity to 0, but only while it still has control.
    if (this.finalPending) { this.finalPending = false; if (this.t < this.cfg.controlEnd) this.qty = 0; }
  }

  startJob(job) { this.kits -= this.cfg.kitsPerJob; this.enqueue(job); this.dispatch(0); }

  onArrival(data) {
    if (data !== 'skip') {
      if (this.wip >= this.cfg.wipLimit) this.dRej += 1;
      else {
        this.wip += 1; this.dAcc += 1;
        const job = { accepted: this.t, contract: this.contract, step: 0, queued: 0 };
        if (this.kits >= this.cfg.kitsPerJob && !this.waiting.length) this.startJob(job);
        else this.waiting.push(job);
        this.checkOrder();
      }
    }
    if (this.arrivals === null) this.nextArrival();
  }

  onKits(q) {
    this.kits += q;
    this.inTransit = false;
    while (this.waiting.length && this.kits >= this.cfg.kitsPerJob) this.startJob(this.waiting.shift());
    this.checkOrder();
  }

  onFinish([s, job]) {
    this.busy[s] -= 1;
    job.step += 1;
    if (job.step < ROUTE.length) { this.enqueue(job); this.dispatch(ROUTE[job.step]); }
    else {
      this.wip -= 1;
      const lead = this.t - job.accepted;
      const rev = revenueFor(this.cfg.contracts[job.contract], lead);
      this.cash += rev;
      this.dDone += 1; this.dRev += rev; this.dLead += lead; this.dLeads.push(lead);
      this.checkOrder();
    }
    this.dispatch(s);
  }

  onDay(day) {
    this.cash += this.prevClose * this.cfg.dailyRate;
    this.prevClose = this.cash;
    this.days.push({
      day, accepted: this.dAcc, rejected: this.dRej, completed: this.dDone,
      revenue: this.dRev, lead: this.dDone ? this.dLead / this.dDone : null, leads: this.dLeads,
      waiting: this.dWait, queue: this.dQ.slice(),
      util: [0, 1, 2].map((s) => (this.dMach[s] ? this.dBusy[s] / this.dMach[s] : 0)),
      machines: this.machines.slice(), cash: this.cash, kits: this.kits, wip: this.wip, contract: this.contract,
    });
    this.resetDay();
    const nxt = day + 1;
    if (nxt > this.cfg.gameEnd) return false;
    if (day < this.cfg.controlEnd) this.applyPolicy(nxt);
    this.push(nxt, DAY, nxt);
    return true;
  }

  applyPolicy(day) {
    const p = this.pol;
    if (p.machines[day]) {
      p.machines[day].forEach((want, s) => {
        while (this.machines[s] < want) {
          const price = this.cfg.prices[s];
          if (this.cash < price) { this.blocked.push([day, 'machine at Station ' + (s + 1)]); break; }
          this.cash -= price; this.machines[s] += 1; this.purchases.push([day, s + 1, +1]);
        }
        while (this.machines[s] > Math.max(want, 1)) {
          this.cash += this.cfg.resale; this.machines[s] -= 1; this.purchases.push([day, s + 1, -1]);
        }
        this.dispatch(s);
      });
    }
    if (day in p.contract) this.contract = p.contract[day];
    if (day in p.rop) this.rop = p.rop[day];
    if (day in p.qty) this.qty = p.qty[day];
    if (day in p.schedule) this.schedule = p.schedule[day];
    if (p.ladder) this.ladderStep();
    if (p.finalDay === day) {
      const size = p.finalQty !== null && p.finalQty !== undefined ? p.finalQty : this.finalOrderSize(day);
      if (size > 0) { this.qty = size; this.rop = 1e9; this.finalPending = true; }
      else this.qty = 0;
    }
    this.checkOrder();
  }

  leadEstimate() {
    const cfg = this.cfg;
    const work = [0, 0, 0];
    for (let s = 0; s < 3; s++) for (const job of this.queue[s]) work[s] += visitTime(cfg, job.step);
    const ahead = this.waiting.length;
    for (let step = 0; step < ROUTE.length; step++) work[ROUTE[step]] += ahead * visitTime(cfg, step);
    let wait = 0;
    for (let s = 0; s < 3; s++) wait += work[s] / Math.max(this.machines[s], 1);
    let kitWait = 0;
    const need = (this.waiting.length + 1) * cfg.kitsPerJob;
    if (this.kits < need) kitWait = this.inTransit ? this.kitsDue() - this.t : cfg.kitLead;
    let pure = 0;
    for (let step = 0; step < ROUTE.length; step++) pure += visitTime(cfg, step);
    return Math.max(wait, kitWait) + pure;
  }

  kitsDue() {
    const due = this.events.a.filter((e) => e.kind === KITS).map((e) => e.t);
    return due.length ? Math.min(...due) : this.t + this.cfg.kitLead;
  }

  ladderStep() {
    if (this.contract > this.pol.ladderTop) this.contract = this.pol.ladderTop; // the ladder's ceiling is a cap
    const lead = this.leadEstimate() * (1 + this.pol.ladderMargin);
    // Only ever step up: a team on the $1,250 contract does not drop back for one busy day.
    let best = this.contract, bestRev = -Infinity;
    for (let c = this.contract; c <= this.pol.ladderTop; c++) {
      const r = revenueFor(this.cfg.contracts[c], lead);
      if (r > bestRev) { best = c; bestRev = r; }   // ties keep the lower contract, as in Python
    }
    this.contract = best;
  }

  finalOrderSize(day) {
    const cfg = this.cfg;
    let pure = 0;
    for (let step = 0; step < ROUTE.length; step++) pure += visitTime(cfg, step);
    const horizon = Math.max(0, cfg.gameEnd - pure - this.t);
    let rates = 0;
    for (let d = day; d <= cfg.gameEnd; d++) rates += this.rate(d);
    const jobsNeeded = rates * horizon / Math.max(cfg.gameEnd - this.t, 1e-9);
    let have = this.kits - this.waiting.length * cfg.kitsPerJob;
    if (this.inTransit) for (const e of this.events.a) if (e.kind === KITS) have += e.data;
    const need = jobsNeeded * cfg.kitsPerJob - have;
    return Math.max(0, Math.trunc(pyRound(need / cfg.kitsPerJob)) * cfg.kitsPerJob);
  }

  run() {
    while (this.events.length) {
      const { t, kind, data } = this.events.pop();
      this.advance(t);
      if (kind === DAY) { if (!this.onDay(data)) break; }
      else if (kind === KITS) this.onKits(data);
      else if (kind === FINISH) this.onFinish(data);
      else if (kind === PLACE) {
        const [day, kits, edge] = data;
        if (edge === 'open') { this.forced = [day, kits]; this.checkForced(); }
        else if (this.forced && this.forced[0] === day) { this.place(kits); this.forced = null; }
      } else this.onArrival(data);
    }
    return {
      days: this.days, orders: this.orders, purchases: this.purchases, blocked: this.blocked,
      finalCash: this.cash, kitsLeft: this.kits, wipLeft: this.wip,
    };
  }
}

// One run from `start` to the end of the game (or to the last replayed arrival).
export function simulate({ cfg = defaultConfig(), pol = policy(), start = startState(), seed = 1, demand = 15.5, arrivals = null } = {}) {
  let c = cfg;
  if (arrivals !== null) c = { ...cfg, gameEnd: Math.min(cfg.gameEnd, Math.floor(Math.max(...arrivals)) + 1) };
  return new Sim(c, pol, start, new Rng(seed), demand, arrivals).run();
}
