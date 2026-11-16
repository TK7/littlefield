// Ask the Operations Advisor (Phase 3).
// The dashboard computes every number here and sends it as telemetry; Claude only explains
// it. Answers stream from /api/chat. Every question and answer is logged on the server and
// can be exported for the course's AI disclosure.

import { rollingMean } from './derive.js';
import { whatIfState, simCall } from './whatif.js';

const $ = (id) => document.getElementById(id);
const r0 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v));
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (v) => (v === null || v === undefined ? null : Math.round(v * 100) + '%');

// Daily margin signatures for competitor forensics: what a team's cash grows by per day,
// at about 15 jobs a day, on each contract (from the Sheet's mix table).
const SIGNATURES = [
  { perDay: 2300, label: '$750 contract' },
  { perDay: 6200, label: '$1,000 contract' },
  { perDay: 9300, label: '$1,250 contract' },
];

let ctx = null;          // { snap, derived }
let history = [];        // [{role, text}] for follow-up questions
let busy = false;

export function setAdvisorData(snap, derived) {
  ctx = { snap, derived };
  history = [];
  $('advDay').textContent = 'Answers use the Day ' + derived.days[derived.days.length - 1].day + ' snapshot'
    + (snap.receivedAt ? ', received ' + new Date(snap.receivedAt).toLocaleString() : '') + '.';
}

// ------------------------------------------------------------------ telemetry
export function baseTelemetry(snap, derived, sim) {
  const days = derived.days;
  const last = days[days.length - 1];
  const s = snap.settings || {};
  const mean = (pick, n) => rollingMean(days, pick, n);
  const kitsTable = Object.fromEntries((snap.tables && snap.tables.kits) || []);
  const t = {
    day: last.day,
    receivedAt: snap.receivedAt || null,
    sourceFile: (snap.source && snap.source.file) || null,
    daysOfControlLeft: Math.max(0, (s.controlEnd || 218) - last.day),
    daysLeftInGame: Math.max(0, (s.gameEnd || 268) - last.day),
    cash: r0(last.cash),
    contractTakingOrders: last.contract,
    machines: last.machines.map((m) => Math.round(m)),
    littlefieldSettings: { reorderPoint: s.rop, orderQuantity: s.q, station2Rule: s.sched, finalOrderPlaced: s.finalPlaced },
    utilization: {
      latestDay: last.util.map(pct),
      last5Days: [0, 1, 2].map((k) => pct(mean((d) => d.util[k], 5))),
      last7Days: [0, 1, 2].map((k) => pct(mean((d) => d.util[k], 7))),
      triggerFromSettings: s.trigger ? pct(s.trigger) : null,
    },
    queueJobsLatestDay: last.queueJobs.map(r2),
    jobsWaitingForKitsLatestDay: r2(last.waiting),
    jobsInFactory: last.wip,
    leadTimeDays: { latestDay: r2(last.leadTime), avg5Days: r2(mean((d) => d.leadTime, 5)) },
    revenuePerJob: { latestDay: r0(last.revPerJob), avg5Days: r0(mean((d) => d.revPerJob, 5)) },
    demandJobsPerDay: {
      last7Days: r2(mean((d) => d.accepted, 7)), last14Days: r2(mean((d) => d.accepted, 14)),
      allDays: r2(mean((d) => d.accepted, days.length)), plan: s.demandPlan || null,
    },
    kits: {
      onHandEstimate: r0(last.kitsOnHand), onOrder: r0(last.kitsOnOrder),
      orderInTransit: kitsTable['Order in transit?'] || (last.kitsOnOrder > 0 ? 'YES' : 'NO'),
      lastOrderDay: kitsTable['Last kit order detected: day'] || null,
      daysOfCover: kitsTable['Days of cover (on hand + on order)'] || null,
    },
    recentEvents: derived.events.filter((e) => e.day > last.day - 10).map((e) => 'Day ' + e.day + ': ' + e.label),
    recentStockouts: derived.stockouts.slice(-3).map((w) => ({ startDay: w.start, endDay: w.end, peakJobsWaiting: r2(w.peak) })),
    playbook: (snap.playbook || []).map(([check, status]) => ({ check, status })),
    sheetSummary: Object.fromEntries(snap.summary || []),
  };
  if (sim && sim.init) {
    const line = (l) => l && {
      day268CashMedian: r0(l.finalP50), day268Cash10th: r0(l.finalP10), day268Cash90th: r0(l.finalP90),
      revenuePerJob: r0(l.revPerJob), kitsLeftOnDay268: r0(l.kitsLeft),
      contractSwitchDay: Object.fromEntries(Object.entries(l.switchDay).filter(([, d]) => d).map(([c, d]) => ['Contract ' + c, Math.round(d)])),
    };
    t.simulator = {
      note: 'Medians of 200 simulated futures from the snapshot day. Presets: Do nothing = current settings, no final order; Safe = 3/4/3, Prioritize Step 4, up to Contract 2, final order Day 210; Recommended = the same up to Contract 3.',
      demandAssumed: r2(sim.init.demand),
      presets: Object.fromEntries(Object.entries(sim.init.lines).map(([k, l]) => [k, line(l)])),
    };
    const d = sim.deck, live = sim.live;
    if (d && live && JSON.stringify(d) !== JSON.stringify(live) && sim.whatif && sim.whatif.line) {
      t.simulator.whatIfBeingTested = {
        note: 'TEST ONLY: settings someone is trying on the dashboard, not what is set in Littlefield.',
        settings: { machines: d.machines, station2Rule: d.schedule, contract: d.contract, autoLadder: d.ladder,
          reorderPoint: d.rop, orderQuantity: d.qty, finalOrderDay: d.finalDay || null, demand: r2(d.demand) },
        result: line(sim.whatif.line),
      };
    }
  }
  return t;
}

const liveSettings = (sim) => sim && sim.live;

async function briefingData(kind, snap, derived, sim) {
  const days = derived.days;
  const last = days[days.length - 1];
  const s = snap.settings || {};
  if (kind === 'audit') {
    const prev = days[days.length - 2];
    const trigger = s.trigger || null;
    const util5 = [0, 1, 2].map((k) => rollingMean(days, (d) => d.util[k], 5));
    const out = {
      stations: [0, 1, 2].map((k) => ({
        station: k + 1, machines: Math.round(last.machines[k]), util5Days: pct(util5[k]),
        overTrigger: trigger ? util5[k] > trigger : null,
      })),
      utilizationTrigger: trigger ? pct(trigger) : null,
      latestAgainstPreviousDay: prev && {
        day: last.day, previousDay: prev.day,
        leadTime: [r2(prev.leadTime), r2(last.leadTime)], revenuePerJob: [r0(prev.revPerJob), r0(last.revPerJob)],
        jobsAccepted: [prev.accepted, last.accepted], jobsCompleted: [prev.completed, last.completed],
        jobsWaitingForKits: [r2(prev.waiting), r2(last.waiting)], cash: [r0(prev.cash), r0(last.cash)],
      },
      latestAgainst5DayAverage: {
        leadTime: [r2(last.leadTime), r2(rollingMean(days, (d) => d.leadTime, 5))],
        revenuePerJob: [r0(last.revPerJob), r0(rollingMean(days, (d) => d.revPerJob, 5))],
      },
      stockoutDaysInLast7: days.slice(-7).filter((d) => d.waiting > 0.5).length,
    };
    out.sincePreviousSnapshot = await previousSnapshotChanges(snap);
    return out;
  }
  if (kind === 'contract') {
    const live = liveSettings(sim);
    const readiness = live ? await simCall('readiness', { settings: live }).catch(() => null) : null;
    return {
      contractTakingOrders: last.contract,
      simulatedForANewOrderAtCurrentSettings: readiness && {
        machines: readiness.machines, station2Rule: readiness.schedule, demand: r2(readiness.demand),
        leadTimeMean: r2(readiness.leadMean), leadTime90th: r2(readiness.leadP90), busiestStationUtilization: pct(readiness.busiest),
        expectedRevenuePerJob: Object.fromEntries(Object.entries(readiness.revenuePerJob).map(([k, v]) => [k, r0(v)])),
        note: 'Steady state with kits never short; it does not include any backlog in the factory now.',
      },
      sheetContractTab: Object.fromEntries((snap.tables && snap.tables.contract) || []),
      playbookContractStatus: ((snap.playbook || []).find(([c]) => /^7\./.test(c)) || [])[1] || null,
    };
  }
  if (kind === 'competitors') return competitorData(snap, last.day);
  if (kind === 'endgame') {
    const live = liveSettings(sim);
    const f = live ? await simCall('final', { settings: live }).catch(() => null) : null;
    return {
      window: f ? { firstDay: f.first, lastDay: f.last } : { firstDay: 193, lastDay: 217 },
      finalOrderPlacedPerSettings: s.finalPlaced || null,
      kitsOnHandEstimate: r0(last.kitsOnHand), kitsOnOrder: r0(last.kitsOnOrder), cash: r0(last.cash),
      byDay: f ? f.rows.map((r) => ({
        day: r.day, goesThroughShareOfRuns: r.fires, kits: r0(r.size), cost: r0(r.cost),
        kitsLeftDay268: r0(r.kitsLeft), day268CashMedian: r0(r.finalCashP50), day268CashBadCase10th: r0(r.finalCashP10),
      })) : [],
      sheetFinalOrder: {
        size: Object.fromEntries((snap.tables && snap.tables.kits) || [])['FINAL ORDER SIZE (kits)'] || null,
        note: 'The Sheet sizes the order as if it were placed today; it shrinks as days pass.',
      },
      steps: f ? f.steps : [],
      playbookFinalOrderStatus: ((snap.playbook || []).find(([c]) => /^9\./.test(c)) || [])[1] || null,
    };
  }
  return null;
}

// Statuses and headline numbers against the previous stored snapshot.
async function previousSnapshotChanges(snap) {
  try {
    const list = await (await fetch('/api/snapshot?list=1', { cache: 'no-store' })).json();
    const earlier = (list.days || []).filter((d) => d < snap.latestDay);
    if (!earlier.length) return { note: 'No earlier snapshot is stored.' };
    const prevDay = earlier[earlier.length - 1];
    const prev = await (await fetch('/api/snapshot?day=' + prevDay, { cache: 'no-store' })).json();
    const before = Object.fromEntries((prev.playbook || []).map(([c, st]) => [c, st]));
    const changed = (snap.playbook || []).filter(([c, st]) => before[c] !== undefined && before[c] !== st)
      .map(([c, st]) => ({ check: c, was: before[c], now: st }));
    return { previousSnapshotDay: prevDay, playbookStatusesChanged: changed };
  } catch (e) {
    return { note: 'Could not load the previous snapshot.' };
  }
}

// Cash change per day for every team between leaderboard rows typed into the Sheet.
export function competitorData(snap, currentDay) {
  const comp = snap.competitors || {};
  const teams = comp.teams || [];
  const rows = (comp.rows || []).slice().sort((a, b) => a[0] - b[0]);
  if (rows.length < 2) return { note: 'Fewer than two leaderboard rows in the Sheet: nothing to compare.', rows: rows.length };
  const first = rows[0], prev = rows[rows.length - 2], last = rows[rows.length - 1];
  const nearest = (perDay) => SIGNATURES.reduce((a, b) => (Math.abs(b.perDay - perDay) < Math.abs(a.perDay - perDay) ? b : a)).label;
  const out = teams.map((name, i) => {
    const c = i + 1;
    const recent = (last[c] - prev[c]) / (last[0] - prev[0]);
    const since = (last[c] - first[c]) / (last[0] - first[0]);
    let drop = null;
    for (let k = 1; k < rows.length; k++) {
      const change = rows[k][c] - rows[k - 1][c];
      if (change < -50000) drop = { betweenDays: [rows[k - 1][0], rows[k][0]], cashChange: r0(change) };
    }
    return {
      team: name, ours: name === (snap.settings && snap.settings.team), cashLatest: r0(last[c]),
      cashChangePerDayLatestInterval: r0(recent), nearestSignatureLatestInterval: recent > 0 ? nearest(recent) : null,
      cashChangePerDaySinceFirstRow: r0(since), largestRecentDrop: drop,
    };
  }).sort((a, b) => b.cashLatest - a.cashLatest);
  out.forEach((t, i) => { t.rank = i + 1; });
  return {
    leaderboardRowDays: rows.map((r) => r[0]), latestRowDay: last[0], daysBehindSnapshot: currentDay - last[0],
    signatures: SIGNATURES.map((x) => x.label + ': about $' + x.perDay.toLocaleString('en-US') + ' a day'),
    caution: 'Kit orders and machine purchases make cash jump down, so short intervals mislead; a drop above $50,000 usually means machines or a large kit order.',
    teams: out,
  };
}

// ------------------------------------------------------------------ asking
async function ask({ question, briefing, label }) {
  if (busy || !ctx) return;
  busy = true;
  setBusy(true);
  const sim = whatIfState();
  const telemetry = baseTelemetry(ctx.snap, ctx.derived, sim);
  if (briefing) telemetry.briefing = await briefingData(briefing, ctx.snap, ctx.derived, sim);
  addTurn('user', label || question, telemetry.day);
  const answer = addTurn('assistant', '', telemetry.day);
  let text = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, briefing, telemetry, history }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: 'The advisor answered ' + res.status + '.' }));
      throw new Error(err.error || 'The advisor answered ' + res.status + '.');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.t === 'text') { text += msg.v; render(answer.body, text); }
        else if (msg.t === 'done') done = msg;
      }
    }
    if (done && done.note) note(answer, done.note, done.error);
    if (done && Number.isFinite(done.remaining)) $('advRemaining').textContent = done.remaining + ' questions left today.';
    if (text) {
      history.push({ role: 'user', text: label || question }, { role: 'assistant', text });
      history = history.slice(-6);
    }
  } catch (e) {
    note(answer, e.message, true);
  } finally {
    busy = false;
    setBusy(false);
  }
}

function setBusy(on) {
  document.querySelectorAll('#advisor button[data-briefing], #advAsk').forEach((b) => { b.disabled = on; });
  $('advStatus').textContent = on ? 'Thinking…' : '';
}

function addTurn(role, text, day) {
  const el = document.createElement('div');
  el.className = 'turn ' + role;
  const head = document.createElement('div');
  head.className = 'turn-head';
  head.textContent = role === 'user' ? 'You' : 'Advisor · Day ' + day + ' data';
  const body = document.createElement('div');
  body.className = 'turn-body';
  el.append(head, body);
  $('advLog').append(el);
  render(body, text);
  el.scrollIntoView({ block: 'end' });
  return { el, body };
}

function note(turn, text, isError) {
  const n = document.createElement('p');
  n.className = 'turn-note' + (isError ? ' bad' : '');
  n.textContent = text;
  turn.el.append(n);
}

// Minimal, safe rendering: paragraphs, "- " lists, **bold**, and the briefing labels.
function render(target, text) {
  target.replaceChildren();
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (m) {
      if (!list) { list = document.createElement(/^\s*\d/.test(line) ? 'ol' : 'ul'); target.append(list); }
      const li = document.createElement('li'); inline(li, m[1]); list.append(li);
    } else {
      list = null;
      const p = document.createElement('p'); inline(p, line.replace(/^#+\s*/, '')); target.append(p);
    }
  }
}

function inline(el, text) {
  const label = /^(Status|Evidence|Action|What would change this):/.exec(text);
  if (label) {
    const b = document.createElement('strong'); b.textContent = label[0]; el.append(b);
    text = text.slice(label[0].length);
  }
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); el.append(b); }
    else if (part) el.append(document.createTextNode(part));
  });
}

// ------------------------------------------------------------------ drawer
export function setupAdvisor() {
  const drawer = $('advisor');
  const open = (on) => {
    drawer.hidden = !on;
    $('advOpen').setAttribute('aria-expanded', String(on));
    if (on) $('advQuestion').focus();
  };
  $('advOpen').addEventListener('click', () => open(drawer.hidden));
  $('advClose').addEventListener('click', () => { open(false); $('advOpen').focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) { open(false); $('advOpen').focus(); } });
  drawer.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-briefing]');
    if (b) ask({ briefing: b.dataset.briefing, label: b.textContent });
  });
  $('advForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('advQuestion').value.trim();
    if (!q) return;
    $('advQuestion').value = '';
    ask({ question: q });
  });
  $('advQuestion').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('advForm').requestSubmit(); }
  });
}
