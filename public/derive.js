// Turns the raw Littlefield download rows into the series the dashboard shows.
// Same logic as the "Daily Log" tab of the Google Sheet, so the two agree.
// Used by the browser and by the tests (plain ES module, no dependencies).

// Column positions in a raw row (the download's columns A to X).
const C = {
  day: 0, waiting: 1, acc: [2, 3, 4],
  q1: 5, u1: 6, m1: 7, q2: 8, u2: 9, m2: 10, q3: 11, u3: 12, m3: 13,
  out: [14, 15, 16], rev: [17, 18, 19], lead: [20, 21, 22], cash: 23,
};

const DEFAULTS = {
  kitsPerJob: 60, kitCost: 10, orderFee: 1000, kitLead: 4, startKits: 9600, startCash: 1000000,
  dailyRate: Math.pow(1.1, 1 / 365) - 1, resale: 10000, kitThreshold: 20000,
  stations: [{ start: 2, price: 90000 }, { start: 3, price: 80000 }, { start: 2, price: 100000 }],
};

const r3 = (x) => Math.round(x * 1000) / 1000;

export function derive(raw, settings = {}) {
  // The Sheet sends 0 for a blank cell. Ignore those so a blank never replaces a real default.
  const given = Object.fromEntries(Object.entries(settings || {}).filter(([, v]) => v !== 0 && v !== null && v !== ''));
  const s = { ...DEFAULTS, ...given };
  const stations = s.stations && s.stations.length === 3 ? s.stations : DEFAULTS.stations;
  const rows = raw.slice().sort((a, b) => a[C.day] - b[C.day]);

  const days = [];
  const events = [];
  let prevCash = s.startCash;
  let prevMach = stations.map((st) => st.start);
  let prevContract = null;
  let cumAccepted = 0, cumCompleted = 0, cumKitsOrdered = 0;
  const recentOrders = []; // kit orders by day, for "on order"

  for (const row of rows) {
    const day = row[C.day];
    const accepted = C.acc.reduce((t, i) => t + row[i], 0);
    const completed = C.out.reduce((t, i) => t + row[i], 0);
    const revenue = C.out.reduce((t, i, k) => t + row[i] * row[C.rev[k]], 0);
    const leadSum = C.out.reduce((t, i, k) => t + row[i] * row[C.lead[k]], 0);
    const cash = row[C.cash] * 1000;
    const mach = [row[C.m1], row[C.m2], row[C.m3]];

    // Which contract took orders today (1, 2 or 3).
    let contract = prevContract;
    if (accepted > 0) {
      let best = 0;
      C.acc.forEach((i, k) => { if (row[i] > row[C.acc[best]]) best = k; });
      contract = best + 1;
    }
    if (prevContract !== null && contract !== prevContract) {
      events.push({ day, type: 'contract', label: 'Contract ' + prevContract + ' to ' + contract });
    }

    // Spending inferred from cash: what cash should be without purchases, minus what it is.
    const spend = prevCash * (1 + s.dailyRate) + revenue - cash;
    let machineSpend = 0;
    mach.forEach((m, k) => {
      const bought = Math.max(0, Math.ceil(r3(m)) - Math.ceil(r3(prevMach[k])));
      const sold = Math.max(0, Math.floor(r3(prevMach[k])) - Math.floor(r3(m)));
      machineSpend += bought * stations[k].price - sold * s.resale;
      if (bought) events.push({ day, type: 'machine', label: 'Bought ' + bought + ' at Station ' + (k + 1) });
      if (sold) events.push({ day, type: 'machine', label: 'Sold ' + sold + ' at Station ' + (k + 1) });
    });
    const kitSpend = spend - machineSpend;
    let kitsOrdered = 0;
    if (kitSpend > s.kitThreshold) {
      kitsOrdered = Math.round((kitSpend - s.orderFee) / s.kitCost / 10) * 10;
      events.push({ day, type: 'kits', label: 'Kit order, ' + kitsOrdered.toLocaleString('en-US') + ' kits' });
    }

    cumAccepted += accepted;
    cumCompleted += completed;
    cumKitsOrdered += kitsOrdered;
    recentOrders.push({ day, kits: kitsOrdered });
    const onOrder = recentOrders.filter((o) => o.day > day - s.kitLead).reduce((t, o) => t + o.kits, 0);
    const position = s.startKits + cumKitsOrdered - s.kitsPerJob * cumAccepted;

    days.push({
      day, accepted, completed, revenue, cash, contract,
      waiting: row[C.waiting],
      revPerJob: completed ? revenue / completed : null,
      leadTime: completed ? leadSum / completed : null,
      util: [row[C.u1], row[C.u2], row[C.u3]],
      machines: mach,
      queueJobs: [row[C.q1], row[C.q2], row[C.q3]].map((k) => k / s.kitsPerJob),
      wip: cumAccepted - cumCompleted,
      kitsOrdered, kitPosition: position, kitsOnOrder: onOrder, kitsOnHand: Math.max(0, position - onOrder),
    });

    prevCash = cash;
    prevMach = mach;
    prevContract = contract;
  }

  return { days, events, stockouts: findStockouts(days), utilization: utilizationAudit(days) };
}

// A stockout wave = consecutive days where, on average, more than half a job waited for kits.
export function findStockouts(days, threshold = 0.5) {
  const waves = [];
  let cur = null;
  for (const d of days) {
    if (d.waiting > threshold) {
      if (!cur) { cur = { start: d.day, end: d.day, peak: d.waiting }; waves.push(cur); }
      cur.end = d.day;
      cur.peak = Math.max(cur.peak, d.waiting);
    } else {
      cur = null;
    }
  }
  return waves.map((w) => ({ ...w, length: w.end - w.start + 1 }));
}

// Average utilization on all days against days with no stockout.
// Starved days pull the plain average down and hide how loaded a station really is.
export function utilizationAudit(days, threshold = 0.5) {
  const all = days;
  const clean = days.filter((d) => d.waiting <= threshold);
  const avg = (list, k) => (list.length ? list.reduce((t, d) => t + d.util[k], 0) / list.length : null);
  return [0, 1, 2].map((k) => ({
    station: k + 1,
    allDays: avg(all, k),
    withoutStockouts: avg(clean, k),
    stockoutDays: all.length - clean.length,
  }));
}

// Average of the last n values of a series, ignoring nulls.
export function rollingMean(days, pick, n) {
  const vals = days.slice(-n).map(pick).filter((v) => v !== null && Number.isFinite(v));
  return vals.length ? vals.reduce((t, v) => t + v, 0) / vals.length : null;
}
