// What-if simulator: control deck, Visual 1 (cash to Day 268), final kit order calculator,
// Visual 2 (utilization against lead time). All simulation runs in a background thread
// (sim/worker.js); this file only draws. Nothing here changes Littlefield.

import { PRIORITY_STEP4, SCHEDULES } from './sim/model.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const usd = (v) => (v === null || v === undefined ? 'n/a' : (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US'));
const signed = (v) => (v === null || v === undefined ? 'n/a' : (v >= 0 ? '+' : '−') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US'));
const int = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-US'));
const two = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(2));
const pct = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v * 100) + '%');

const REC = 'Recommended (3/4/3, up to $1,250)';
const SAFE = 'Safe (3/4/3, up to $1,000)';
const NOTHING = 'Do nothing';
const WHATIF = 'What-if';
const LINE_COLOR = { [WHATIF]: '--series-a', [NOTHING]: '--text-muted', [SAFE]: '--series-2', [REC]: '--series-b' };
const RANGES = { m0: [1, 5], m1: [1, 6], m2: [1, 5] };

let worker = null;
let seq = 0;
const pending = new Map();
let state = null;     // { snap, derived, init, live, deck, whatif, final }
let charts = { cash: null, curve: null };
let timer = null;

function call(type, payload) {
  if (!worker) worker = new Worker(new URL('./sim/worker.js', import.meta.url), { type: 'module' });
  if (!worker.onmessage) {
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, type, ...payload }); });
}

// ------------------------------------------------------------------ entry point
export async function initWhatIf(snap, derived) {
  const s = snap.settings || {};
  const last = derived.days[derived.days.length - 1];
  const controlEnd = s.controlEnd || 218;
  state = { snap, derived, init: null, whatif: null, final: null, controlEnd, gen: (state ? state.gen : 0) + 1 };
  const gen = state.gen;
  $('wiStatus').textContent = 'Running 600 simulations from Day ' + last.day + '…';
  $('wiBody').hidden = true;
  let init;
  try {
    init = await call('init', { snap });
  } catch (e) {
    $('wiStatus').textContent = 'The simulator could not start: ' + e.message;
    return;
  }
  if (gen !== state.gen) return; // a newer snapshot was loaded meanwhile
  state.init = init;
  const st = init.start;
  state.live = {
    machines: st.machines.slice(), schedule: st.schedule, contract: st.contract, ladder: false,
    rop: st.rop, qty: st.qty, finalDay: 0, demand: init.demand,
  };
  state.deck = { ...state.live, machines: st.machines.slice() };
  $('wiBody').hidden = false;
  buildDeck();
  checkSheet();
  const ended = last.day >= controlEnd;
  $('wiEnded').hidden = !ended;
  document.querySelectorAll('#wiDeck input, #wiDeck select, #wiPresets button').forEach((el) => { el.disabled = ended; });
  run();
}

const round1 = (x) => Math.round(x * 10) / 10;

// ------------------------------------------------------------------ control deck
function buildDeck() {
  const st = state.init.start;
  const s = state.snap.settings || {};
  const prices = (s.stations || []).map((x) => x.price);
  const deck = $('wiDeck');
  deck.replaceChildren();
  const first = Math.max(193, st.day + 1), last = state.controlEnd - 1;

  const card = (label, nowText, control, note) => {
    const el = document.createElement('div');
    el.className = 'lever';
    const head = document.createElement('div');
    head.className = 'lever-head';
    const lab = document.createElement('label');
    lab.textContent = label;
    lab.htmlFor = control.id;
    const now = document.createElement('span');
    now.className = 'now';
    now.textContent = 'Now: ' + nowText;
    head.append(lab, now);
    el.append(head, control);
    if (note) { const n = document.createElement('div'); n.className = 'lever-note small'; n.id = note; el.append(n); }
    deck.append(el);
  };
  const number = (id, value, min, max, step) => {
    const i = document.createElement('input');
    Object.assign(i, { id, type: 'number', value, min, max, step, inputMode: 'numeric' });
    i.addEventListener('change', onDeckChange);
    return i;
  };
  const select = (id, options, value) => {
    const sel = document.createElement('select');
    sel.id = id;
    options.forEach(([v, t]) => sel.add(new Option(t, v)));
    sel.value = String(value);
    sel.addEventListener('change', onDeckChange);
    return sel;
  };

  for (let k = 0; k < 3; k++) {
    card('Station ' + (k + 1) + ' machines', String(st.machines[k]),
      number('wiM' + k, state.deck.machines[k], RANGES['m' + k][0], RANGES['m' + k][1], 1), 'wiM' + k + 'Note');
    if (prices[k]) $('wiM' + k).dataset.price = prices[k];
  }
  card('Station 2 rule', st.schedule, select('wiSched', SCHEDULES.map((r) => [r, r]), state.deck.schedule));
  card('Contract for new orders', contractName(st.contract), select('wiContract',
    [[1, 'Contract 1: $750 (7 / 14 days)'], [2, 'Contract 2: $1,000 (1 / 3 days)'], [3, 'Contract 3: $1,250 (0.5 / 1 day)']], state.deck.contract));
  const lad = document.createElement('label');
  lad.className = 'check';
  const cb = document.createElement('input');
  Object.assign(cb, { type: 'checkbox', id: 'wiLadder', checked: state.deck.ladder });
  cb.addEventListener('change', onDeckChange);
  lad.append(cb, document.createTextNode(' Auto-ladder: step up to this contract only when lead times allow'));
  deck.lastChild.append(lad);
  card('Reorder point (kits)', int(st.rop), number('wiRop', state.deck.rop, 0, 12000, 60));
  card('Order quantity (kits)', int(st.qty), number('wiQty', state.deck.qty, 0, 40000, 60), 'wiQtyNote');
  const finals = [[0, 'None (keep ordering)']];
  for (let d = first; d <= last; d++) finals.push([d, 'Day ' + d]);
  card('Final kit order', 'not placed', select('wiFinal', finals, state.deck.finalDay));
  card('Demand assumed (jobs a day)', round1(state.init.demand) + (state.init.demandSource === 'plan'
    ? ' (Settings plan; last 14 days ' + round1(state.init.recentDemand) + ')' : ' (last 14 days)'),
    number('wiDemand', round1(state.deck.demand), 4, 30, 0.1));
  updateNotes();
}

function contractName(c) { return 'Contract ' + c + ' (' + ['$750', '$1,000', '$1,250'][c - 1] + ')'; }

function readDeck() {
  const n = (id) => Number($(id).value);
  return {
    machines: [0, 1, 2].map((k) => Math.min(RANGES['m' + k][1], Math.max(RANGES['m' + k][0], Math.round(n('wiM' + k))))),
    schedule: $('wiSched').value, contract: Number($('wiContract').value), ladder: $('wiLadder').checked,
    rop: Math.max(0, Math.round(n('wiRop') / 60) * 60), qty: Math.max(0, Math.round(n('wiQty') / 60) * 60),
    finalDay: Number($('wiFinal').value) || 0, demand: demandFrom(n('wiDemand')),
  };
}

// The box shows demand to one decimal; while it still shows the measured figure, use it exactly.
function demandFrom(v) {
  if (!v || v < 1) return state.init.demand;
  return v === round1(state.init.demand) ? state.init.demand : v;
}

function writeDeck(d) {
  [0, 1, 2].forEach((k) => { $('wiM' + k).value = d.machines[k]; });
  $('wiSched').value = d.schedule; $('wiContract').value = String(d.contract); $('wiLadder').checked = d.ladder;
  $('wiRop').value = d.rop; $('wiQty').value = d.qty; $('wiFinal').value = String(d.finalDay); $('wiDemand').value = round1(d.demand);
}

function onDeckChange() {
  state.deck = readDeck();
  updateNotes();
  clearTimeout(timer);
  timer = setTimeout(run, 250);
}

// Purchase cost, cash rule, order-quantity warning, and the "test only" banner.
function updateNotes() {
  const st = state.init.start;
  const s = state.snap.settings || {};
  const d = state.deck;
  let spend = 0;
  for (let k = 0; k < 3; k++) {
    const diff = d.machines[k] - st.machines[k];
    const price = (s.stations && s.stations[k] && s.stations[k].price) || 0;
    const note = $('wiM' + k + 'Note');
    if (diff > 0) { spend += diff * price; note.textContent = 'Buy ' + diff + ': ' + usd(diff * price); }
    else if (diff < 0) { spend -= -diff * (s.resale || 10000); note.textContent = 'Sell ' + -diff + ': +' + usd(-diff * (s.resale || 10000)); }
    else note.textContent = '';
  }
  const kitOrder = d.qty * (s.kitCost || 10) + (s.orderFee || 1000);
  state.blocked = spend > 0 && st.cash - spend < kitOrder;
  const qn = $('wiQtyNote');
  const fourDays = 4 * d.demand * (s.kitsPerJob || 60);
  qn.textContent = d.qty === 0 ? 'Ordering is off.'
    : d.qty < fourDays ? 'Below four days of demand (' + int(fourDays) + ' kits): only one order can be on the way, so stockouts are likely.' : '';
  qn.className = 'lever-note small' + (d.qty > 0 && d.qty < fourDays ? ' warn' : '');

  const live = state.live;
  const diffs = [];
  if (d.machines.join() !== live.machines.join()) diffs.push('machines ' + d.machines.join('/'));
  if (d.schedule !== live.schedule) diffs.push(d.schedule);
  if (d.contract !== live.contract || d.ladder) diffs.push((d.ladder ? 'ladder up to ' : '') + contractName(d.contract));
  if (d.rop !== live.rop) diffs.push('reorder point ' + int(d.rop));
  if (d.qty !== live.qty) diffs.push('order quantity ' + int(d.qty));
  if (d.finalDay) diffs.push('final order on Day ' + d.finalDay);
  if (d.demand !== live.demand) diffs.push('demand ' + round1(d.demand) + ' a day');
  const banner = $('wiBanner');
  banner.hidden = !diffs.length;
  banner.textContent = 'TEST ONLY. These settings differ from Littlefield: ' + diffs.join(', ') + '. Nothing here changes the game; follow the Playbook.';
  const block = $('wiBlocked');
  block.hidden = !state.blocked;
  block.textContent = 'Blocked: buying these machines (' + usd(spend) + ') would leave ' + usd(st.cash - spend)
    + ', less than one kit order (' + usd(kitOrder) + '). Littlefield would not leave room to reorder kits.';
}

function preset(name) {
  const st = state.init.start;
  const plan = (top) => ({ machines: [3, 4, 3], schedule: PRIORITY_STEP4, contract: top, ladder: true, rop: 6000, qty: 26700,
    finalDay: Math.min(Math.max(210, st.day + 1), state.controlEnd - 1), demand: state.live.demand });
  const d = name === 'reset' || name === 'nothing' ? { ...state.live, machines: state.live.machines.slice() }
    : name === 'safe' ? plan(2) : plan(3);
  if (d.finalDay && !$('wiFinal').querySelector('option[value="' + d.finalDay + '"]')) d.finalDay = 0;
  writeDeck(d);
  onDeckChange();
}

// Flag results when the Sheet's demand or process-time checks are not OK.
function checkSheet() {
  const rows = state.snap.playbook || [];
  const bad = rows.filter(([check, status]) => /^1[01]\./.test(check) && !String(status).startsWith('OK'));
  const el = $('wiCaution');
  el.hidden = !bad.length;
  el.textContent = 'Treat these results with care: ' + bad.map(([c, s]) => c.replace(/^\d+\.\s*/, '') + ' says "' + s + '"').join('; ')
    + '. The model was calibrated on earlier days.';
}

// ------------------------------------------------------------------ running
async function run() {
  if (state.blocked) { $('wiStatus').textContent = 'Not simulated: the machine purchase is blocked (see above).'; return; }
  const gen = state.gen;
  const settings = state.deck;
  $('wiStatus').textContent = 'Simulating 200 runs…';
  const t0 = performance.now();
  try {
    const [w, f] = await Promise.all([call('whatif', { settings }), call('final', { settings })]);
    if (gen !== state.gen || settings !== state.deck) return; // superseded
    state.whatif = w; state.final = f;
    $('wiStatus').textContent = 'Updated in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s. Each line is the median of 200 runs from Day '
      + state.init.start.day + ', with demand at ' + round1(w.demand) + ' jobs a day.';
    drawCash(); drawFinal(); drawCurve();
  } catch (e) {
    $('wiStatus').textContent = 'Simulation failed: ' + e.message;
  }
}

// ------------------------------------------------------------------ Visual 1
function rgba(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function lines() {
  const out = [];
  if (state.whatif && state.whatif.line) out.push([WHATIF, state.whatif.line]);
  for (const name of [NOTHING, SAFE, REC]) if (state.init.lines[name]) out.push([name, state.init.lines[name]]);
  return out;
}

function drawCash() {
  const days = state.derived.days;
  const start = state.init.start;
  const ink = { muted: css('--text-muted'), grid: css('--grid'), text: css('--text-primary') };
  const ds = [{
    label: 'Actual cash', data: days.map((d) => ({ x: d.day, y: d.cash })), borderColor: ink.text, backgroundColor: ink.text,
    borderWidth: 2, pointRadius: 0, tension: 0,
  }];
  for (const [name, line] of lines()) {
    const c = css(LINE_COLOR[name]);
    const anchor = { x: start.day, y: start.cash };
    ds.push({ label: name + ' 90th', data: [anchor, ...line.byDay.map((d) => ({ x: d.day, y: d.p90 }))], borderWidth: 0, pointRadius: 0, fill: false, borderColor: 'transparent', band: true });
    ds.push({ label: name + ' 10th', data: [anchor, ...line.byDay.map((d) => ({ x: d.day, y: d.p10 }))], borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: rgba(c, 0.12), borderColor: 'transparent', band: true });
    ds.push({ label: name, data: [anchor, ...line.byDay.map((d) => ({ x: d.day, y: d.p50 }))], borderColor: c, backgroundColor: c,
      borderWidth: name === WHATIF ? 2.5 : 1.75, borderDash: name === NOTHING ? [5, 4] : [], pointRadius: 0, tension: 0 });
  }
  if (charts.cash) charts.cash.destroy();
  charts.cash = new Chart($('wiCash'), {
    type: 'line', data: { datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => !item.dataset.band,
          callbacks: { title: (items) => 'Day ' + items[0].parsed.x, label: (item) => ' ' + item.dataset.label + ': ' + usd(item.parsed.y) },
        },
      },
      scales: {
        x: { type: 'linear', min: 1, max: 268, ticks: { color: ink.muted, stepSize: 50, maxRotation: 0 }, grid: { display: false }, border: { color: ink.grid } },
        y: { ticks: { color: ink.muted, maxTicksLimit: 5, callback: (v) => '$' + (v / 1e6).toFixed(1) + 'M' }, grid: { color: ink.grid }, border: { display: false } },
      },
    },
    plugins: [vline(start.day, 'Day ' + start.day, ink), vline(state.controlEnd, 'Control ends', ink)],
  });
  const legend = $('wiCashLegend');
  legend.replaceChildren(...[['Actual cash', '--text-primary'], ...lines().map(([n]) => [n, LINE_COLOR[n]])].map(([n, c]) => {
    const key = document.createElement('span'); key.className = 'key';
    const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = css(c);
    key.append(sw, document.createTextNode(n));
    return key;
  }));
  const rec = state.init.lines[REC];
  const body = $('wiCashTable').tBodies[0];
  body.replaceChildren(...lines().map(([name, l]) => {
    const tr = document.createElement('tr');
    const switches = [2, 3].filter((c) => l.switchDay[c] && l.switchRuns[c] >= 0.5).map((c) => 'C' + c + ' Day ' + Math.round(l.switchDay[c])).join(', ');
    [name, usd(l.finalP50), usd(l.finalP10) + ' to ' + usd(l.finalP90), rec ? signed(l.finalP50 - rec.finalP50) : 'n/a',
      usd(l.revPerJob), switches || '—', int(l.kitsLeft)].forEach((v, i) => {
      const td = document.createElement('td'); td.textContent = v; if (i) td.className = 'num'; tr.append(td);
    });
    if (name === WHATIF) tr.className = 'whatif-row';
    return tr;
  }));
}

function vline(x, label, ink) {
  return {
    id: 'v' + label,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales } = chart;
      const px = scales.x.getPixelForValue(x);
      if (px < a.left || px > a.right) return;
      ctx.save();
      ctx.strokeStyle = ink.muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.fillStyle = ink.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(label, px - 4, a.top + 11);
      ctx.restore();
    },
  };
}

// ------------------------------------------------------------------ final kit order
function drawFinal() {
  const f = state.final;
  const st = state.init.start;
  const s = state.snap.settings || {};
  const status = [];
  status.push(st.orderArrives !== null
    ? 'A kit order of ' + int(st.orderQty) + ' is on the way, due about Day ' + Math.ceil(st.orderArrives) + '. A new order cannot be placed until it arrives.'
    : 'No kit order is on the way now.');
  status.push('Kits on hand (est.): ' + int(st.kits) + '. Cash: ' + usd(st.cash) + '.');
  const nr = f.nextRegular;
  if (nr && nr.beforeControlEnds >= 0.5) {
    status.push('If nothing changes, Littlefield places its next automatic order of ' + int(nr.kits) + ' kits around Day ' + nr.day
      + '. To make the final order that one instead, change the settings before then.');
  }
  const lo = state.init.lastOrder;
  if (lo && lo.kits !== st.qty) {
    status.push('Check the Settings tab: the last order (Day ' + lo.day + ') was ' + int(lo.kits) + ' kits, but the order quantity there is ' + int(st.qty) + '.');
  }
  if (f.sizeRule) {
    status.push('Size rule: ' + int(f.sizeRule.kitsPerDay) + ' kits a day (' + round1(f.demand) + ' jobs) from the moment it is placed until Day '
      + f.sizeRule.until.toFixed(1) + ', minus kits on hand and on order. Each day of delay takes about ' + int(f.sizeRule.kitsPerDay) + ' kits off.');
  }
  if (String(s.finalPlaced || '').toUpperCase().startsWith('Y')) status.unshift('The Settings tab says the final order has been placed.');
  if (st.day < f.first - 1) status.push('The window opens on Day ' + f.first + ', ' + (f.first - st.day) + ' days from the snapshot day.');
  $('wiFinalStatus').textContent = status.join(' ');
  const body = $('wiFinalTable').tBodies[0];
  if (!f.rows.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 7;
    td.textContent = 'Control has ended: the final order can no longer be placed.'; tr.append(td); body.replaceChildren(tr);
    $('wiFinalAdvice').textContent = '';
  } else {
    const best = Math.max(...f.rows.map((r) => r.finalCashP50));
    const bestLow = Math.max(...f.rows.map((r) => r.finalCashP10));
    const good = (r) => r.fires >= 0.95 && best - r.finalCashP50 < 5000 && bestLow - r.finalCashP10 < 10000;
    const risky = (r) => r.fires < 0.95 || bestLow - r.finalCashP10 > 20000;
    body.replaceChildren(...f.rows.map((r) => {
      const tr = document.createElement('tr');
      [String(r.day), pct(r.fires), r.size === null ? 'n/a' : int(r.size), usd(r.cost), int(r.kitsLeft), usd(r.finalCashP50), usd(r.finalCashP10)].forEach((v, i) => {
        const td = document.createElement('td'); td.textContent = v; if (i) td.className = 'num'; tr.append(td);
      });
      tr.className = risky(r) ? 'warn-row' : good(r) ? 'good-row' : '';
      return tr;
    }));
    const ok = f.rows.filter(good).map((r) => r.day);
    const bad = f.rows.filter(risky).map((r) => r.day);
    $('wiFinalAdvice').textContent = (ok.length ? 'Safe to place on: Day ' + ok.join(', ') + '. ' : '')
      + (bad.length ? 'Risky: Day ' + bad.join(', ') + '. ' : '')
      + 'Between the days shown, the result changes little; what matters is that the order goes through while there is still time to set the quantity to 0.';
  }
  $('wiFinalSteps').replaceChildren(...f.steps.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
}

// ------------------------------------------------------------------ Visual 2
function drawCurve() {
  const w = state.whatif;
  const ink = { muted: css('--text-muted'), grid: css('--grid'), text: css('--text-primary'), good: css('--good-bg'), warn: css('--warning-bg'), bad: css('--critical-bg') };
  const days = state.derived.days.slice(-5);
  const today = {
    x: Math.max(...[0, 1, 2].map((k) => days.reduce((t, d) => t + d.util[k], 0) / days.length)),
    y: avg(days.map((d) => d.leadTime).filter((v) => v !== null)),
  };
  const pts = (pick) => w.curve.filter((r) => pick(r) !== null).map((r) => ({ x: r.bottleneck, y: pick(r) }));
  const c1 = css('--series-a'), c2 = css('--text-secondary');
  const ds = [
    { label: 'Simulated mean', data: pts((r) => r.leadMean), borderColor: c1, backgroundColor: c1, borderWidth: 2, pointRadius: 2, tension: 0.2 },
    { label: 'Simulated 90th percentile', data: pts((r) => r.leadP90), borderColor: c1, backgroundColor: c1, borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, tension: 0.2 },
    { label: 'Textbook M/M/c (upper bound)', data: pts((r) => r.mmc), borderColor: c2, backgroundColor: c2, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, tension: 0.2 },
    { label: 'Today (last 5 days)', data: today.y === null ? [] : [today], type: 'scatter', borderColor: ink.text, backgroundColor: ink.text, pointRadius: 6, pointStyle: 'rectRot' },
    { label: 'What-if', data: [{ x: w.here.bottleneck, y: w.here.leadMean }], type: 'scatter', borderColor: c1, backgroundColor: css('--surface-1'), borderWidth: 2.5, pointRadius: 7 },
  ];
  if (charts.curve) charts.curve.destroy();
  const zones = {
    id: 'zones',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { y } } = chart;
      const band = (lo, hi, color, label) => {
        const top = Math.max(a.top, y.getPixelForValue(hi)), bottom = Math.min(a.bottom, y.getPixelForValue(lo));
        if (bottom <= top) return;
        ctx.fillStyle = color; ctx.fillRect(a.left, top, a.right - a.left, bottom - top);
        ctx.fillStyle = ink.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(label, a.right - 6, top + 13);
      };
      ctx.save();
      band(0, 0.5, ink.good, '$1,250 contract pays in full');
      band(0.5, 1, ink.warn, '$1,250 falls to $0 at 1 day; $1,000 still full');
      band(1, 3, ink.bad, '$1,000 falls to $0 at 3 days');
      ctx.restore();
    },
  };
  charts.curve = new Chart($('wiCurve'), {
    type: 'line', data: { datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: ink.muted, boxWidth: 14, boxHeight: 2, font: { size: 11.5 } } },
        tooltip: { callbacks: { label: (item) => ' ' + item.dataset.label + ': ' + pct(item.parsed.x) + ' busy, ' + two(item.parsed.y) + ' days' } },
      },
      scales: {
        x: { type: 'linear', min: 0.3, max: 1, title: { display: true, text: 'Busiest station utilization', color: ink.muted },
             ticks: { color: ink.muted, callback: (v) => Math.round(v * 100) + '%' }, grid: { display: false }, border: { color: ink.grid } },
        y: { min: 0, max: 1.5, title: { display: true, text: 'Lead time (days)', color: ink.muted },
             ticks: { color: ink.muted, stepSize: 0.25, callback: (v) => v.toFixed(2) }, grid: { color: ink.grid }, border: { display: false } },
      },
    },
    plugins: [zones],
  });
  const h = w.here;
  $('wiCurveReadout').textContent = 'At the what-if settings (' + state.deck.machines.join('/') + ', ' + round1(w.demand) + ' jobs a day): busiest station '
    + pct(h.bottleneck) + ', lead time ' + two(h.leadMean) + ' days (90th percentile ' + two(h.leadP90) + '). Expected revenue per job: '
    + '$750 contract ' + usd(h.rev1) + ', $1,000 contract ' + usd(h.rev2) + ', $1,250 contract ' + usd(h.rev3) + '.'
    + (h.mmc ? ' The textbook M/M/c formula would say ' + two(h.mmc) + ' days.' : '');
}

const avg = (xs) => (xs.length ? xs.reduce((t, v) => t + v, 0) / xs.length : null);

// ------------------------------------------------------------------ for the advisor
// The simulator state and a way to ask the background thread for more.
export function whatIfState() {
  return state && state.init ? state : null;
}

export function simCall(type, payload) {
  return call(type, payload);
}

// ------------------------------------------------------------------ wiring
export function setupWhatIf() {
  $('wiPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (b && state && state.init) preset(b.dataset.preset);
  });
}

export function redrawWhatIf() {
  if (state && state.whatif) { drawCash(); drawCurve(); }
}

