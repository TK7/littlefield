import { derive, rollingMean } from './derive.js';
import { initWhatIf, setupWhatIf, redrawWhatIf } from './whatif.js';
import { setAdvisorData, setupAdvisor } from './advisor.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = {
  int: (v) => (v === null ? 'n/a' : Math.round(v).toLocaleString('en-US')),
  one: (v) => (v === null ? 'n/a' : v.toFixed(1)),
  two: (v) => (v === null ? 'n/a' : v.toFixed(2)),
  pct: (v) => (v === null ? 'n/a' : Math.round(v * 100) + '%'),
  usd: (v) => (v === null ? 'n/a' : '$' + Math.round(v).toLocaleString('en-US')),
};

// One panel per measure. Stations keep the same colour in every panel.
const STATION = ['--series-1', '--series-2', '--series-3'];
const PANELS = [
  { id: 'orders', title: 'Jobs accepted and completed (per day)', on: true, f: fmt.int, series: [
    { label: 'Accepted', color: '--series-a', pick: (d) => d.accepted },
    { label: 'Completed', color: '--series-b', pick: (d) => d.completed }] },
  { id: 'waiting', title: 'Jobs waiting for kits (daily average)', on: true, f: fmt.one, tick: fmt.int, series: [
    { label: 'Waiting for kits', color: '--series-solo', pick: (d) => d.waiting }] },
  { id: 'util', title: 'Utilization by station', on: true, f: fmt.pct, max: 1, series: [0, 1, 2].map((k) => (
    { label: 'Station ' + (k + 1), color: STATION[k], pick: (d) => d.util[k] })) },
  { id: 'queue', title: 'Queue at each station (jobs)', on: true, f: fmt.one, tick: fmt.int, series: [0, 1, 2].map((k) => (
    { label: 'Station ' + (k + 1), color: STATION[k], pick: (d) => d.queueJobs[k] })) },
  { id: 'lead', title: 'Lead time of completed jobs (days)', on: true, f: fmt.two, tick: fmt.one, series: [
    { label: 'Lead time', color: '--series-solo', pick: (d) => d.leadTime }] },
  { id: 'rev', title: 'Revenue per completed job ($)', on: false, f: fmt.usd, series: [
    { label: 'Revenue per job', color: '--series-solo', pick: (d) => d.revPerJob }] },
  { id: 'wip', title: 'Jobs in the factory (limit 100)', on: false, f: fmt.int, series: [
    { label: 'Jobs in the factory', color: '--series-solo', pick: (d) => d.wip }] },
  { id: 'cash', title: 'Cash ($)', on: true, f: fmt.usd, zero: false, series: [
    { label: 'Cash', color: '--series-solo', pick: (d) => d.cash }] },
];

let model = null;       // derived data for the snapshot on screen
let charts = [];
let hoverDay = null;

// ---------------------------------------------------------------- loading
async function load(day) {
  $('headline').textContent = 'Loading…';
  let res;
  try {
    res = await fetch('/api/snapshot' + (day ? '?day=' + encodeURIComponent(day) : ''), { cache: 'no-store' });
  } catch (e) {
    return showEmpty('Could not reach the server. Check your connection and press Refresh.');
  }
  if (res.status === 404) {
    return showEmpty('The Google Sheet has not sent a snapshot yet. In the Sheet, use the menu Littlefield > Push to dashboard now.');
  }
  if (!res.ok) return showEmpty('The server returned an error (' + res.status + '). Press Refresh to try again.');
  const snap = await res.json();
  render(snap);
}

async function loadDayList() {
  try {
    const res = await fetch('/api/snapshot?list=1', { cache: 'no-store' });
    if (!res.ok) return;
    const { days } = await res.json();
    const sel = $('daySelect');
    const keep = sel.value;
    sel.length = 1;
    days.slice().reverse().forEach((d) => sel.add(new Option('Day ' + d, String(d))));
    sel.value = keep;
  } catch (e) { /* the list is a convenience; the page works without it */ }
}

function showEmpty(message) {
  $('app').hidden = true;
  $('empty').hidden = false;
  $('emptyMsg').textContent = message;
  $('headline').textContent = '';
}

// ---------------------------------------------------------------- rendering
function render(snap) {
  $('empty').hidden = true;
  $('app').hidden = false;
  model = derive(snap.raw, snap.settings);
  model.snap = snap;
  const last = model.days[model.days.length - 1];

  const src = snap.source || {};
  const received = snap.receivedAt ? new Date(snap.receivedAt) : null;
  $('headline').textContent = 'Data through Day ' + last.day
    + (src.file ? '  ·  from "' + src.file + '"' : '')
    + (received ? '  ·  received ' + received.toLocaleString() : '');
  const s = snap.settings || {};
  const ctrl = (s.controlEnd || 218) - last.day;
  $('control').textContent = ctrl > 0
    ? 'Days of control left: ' + ctrl + '   ·   Days left in the game: ' + ((s.gameEnd || 268) - last.day)
    : 'Control has ended. No more changes are possible.';

  // Tiles: label/value pairs exactly as the Sheet's Playbook shows them.
  const tiles = $('tiles');
  tiles.replaceChildren(...(snap.summary || []).map(([label, value]) => {
    const el = document.createElement('div');
    el.className = 'tile';
    el.append(div('label', label), div('value', value));
    return el;
  }));

  // Playbook statuses, word for word.
  const body = $('playbook').tBodies[0];
  body.replaceChildren(...(snap.playbook || []).map(([check, status, why]) => {
    const tr = document.createElement('tr');
    const kind = classify(status);
    const st = div('status ' + kind.cls);
    st.append(div('tag', kind.tag), div('', status));
    tr.append(td(check), tdNode(st), td(why));
    return tr;
  }));

  renderToggles();
  renderPanels();
  renderAudit();
  initWhatIf(snap, model);
  setAdvisorData(snap, model);
}

// Same rule as the Sheet's colour coding: the first word of the status decides.
function classify(text) {
  const t = String(text || '');
  const starts = (list) => list.some((w) => t.startsWith(w));
  if (starts(['OK', 'STAY'])) return { cls: 'ok', tag: 'OK' };
  if (starts(['WATCH', 'HOLD', 'Wait', 'Not yet'])) return { cls: 'wait', tag: 'WAIT' };
  return { cls: 'act', tag: 'ACT' };
}

function renderToggles() {
  const box = $('panelToggles');
  box.replaceChildren(...PANELS.map((p) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.on;
    cb.addEventListener('change', () => { p.on = cb.checked; renderPanels(); });
    label.append(cb, document.createTextNode(p.title.replace(/ \(.*\)$/, '')));
    return label;
  }));
}

function renderPanels() {
  charts.forEach((c) => c.destroy());
  charts = [];
  const host = $('panels');
  host.replaceChildren();
  const days = model.days;
  const xMin = days[0].day, xMax = days[days.length - 1].day;
  const ink = { text: css('--text-secondary'), muted: css('--text-muted'), grid: css('--grid'), band: css('--band'), strong: css('--text-primary'), surface: css('--surface-1') };

  for (const p of PANELS.filter((x) => x.on)) {
    const wrap = div('panel');
    const head = div('panel-head');
    head.append(div('panel-title', p.title));
    if (p.series.length > 1) {
      const legend = div('legend');
      p.series.forEach((sr) => {
        const key = div('key');
        const sw = div('swatch');
        sw.style.background = css(sr.color);
        key.append(sw, document.createTextNode(sr.label));
        legend.append(key);
      });
      head.append(legend);
    }
    const holder = div('panel-canvas');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', p.title + ', Days ' + xMin + ' to ' + xMax + '. The same numbers are in the daily table below.');
    holder.append(canvas);
    wrap.append(head, holder);
    host.append(wrap);

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: p.series.map((sr) => ({
        label: sr.label,
        data: days.map((d) => ({ x: d.day, y: sr.pick(d) })),
        borderColor: css(sr.color), backgroundColor: css(sr.color),
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12,
        pointHoverBorderColor: ink.surface, pointHoverBorderWidth: 2,
        spanGaps: false, tension: 0,
      })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => 'Day ' + items[0].parsed.x,
              label: (item) => ' ' + item.dataset.label + ': ' + p.f(item.parsed.y),
            },
          },
        },
        scales: {
          x: { type: 'linear', min: xMin, max: xMax,
               ticks: { color: ink.muted, stepSize: 10, maxRotation: 0, callback: (v) => (Number.isInteger(v) ? v : '') },
               grid: { display: false }, border: { color: ink.grid } },
          y: { beginAtZero: p.zero !== false, max: p.max,
               ticks: { color: ink.muted, maxTicksLimit: 4, callback: (v) => (p.tick || p.f)(v) },
               grid: { color: ink.grid }, border: { display: false },
               afterFit: (scale) => { scale.width = 76; } }, // same width on every panel so the day axes line up
        },
        onHover: (evt, _active, c) => {
          const x = c.scales.x.getValueForPixel(evt.x);
          setHover(Math.max(xMin, Math.min(xMax, Math.round(x))));
        },
      },
      plugins: [overlay(ink)],
    });
    canvas.addEventListener('mouseleave', () => setHover(null));
    charts.push(chart);
  }
}

// Draws stockout bands, event lines and the shared crosshair on every panel.
function overlay(ink) {
  return {
    id: 'lfOverlay',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      ctx.save();
      ctx.fillStyle = ink.band;
      for (const w of model.stockouts) {
        const left = Math.max(a.left, x.getPixelForValue(w.start - 0.5));
        const right = Math.min(a.right, x.getPixelForValue(w.end + 0.5));
        if (right > left) ctx.fillRect(left, a.top, right - left, a.bottom - a.top);
      }
      ctx.strokeStyle = ink.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const day of new Set(model.events.map((e) => e.day))) {
        const px = x.getPixelForValue(day);
        if (px < a.left || px > a.right) continue;
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      if (hoverDay === null) return;
      const { ctx, chartArea: a, scales: { x } } = chart;
      const px = x.getPixelForValue(hoverDay);
      ctx.save();
      ctx.strokeStyle = ink.strong;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.restore();
    },
  };
}

function setHover(day) {
  if (day === hoverDay) return;
  hoverDay = day;
  charts.forEach((c) => c.draw());
  const out = $('readout');
  if (day === null) { out.textContent = 'Move over a chart to read one day across all panels.'; return; }
  const d = model.days.find((x) => x.day === day);
  if (!d) return;
  const ev = model.events.filter((e) => e.day === day).map((e) => e.label);
  out.textContent = 'Day ' + day + ':  accepted ' + d.accepted + ', completed ' + d.completed
    + '  ·  waiting for kits ' + fmt.one(d.waiting)
    + '  ·  utilization ' + d.util.map(fmt.pct).join(' / ')
    + '  ·  lead time ' + fmt.two(d.leadTime) + ' days'
    + '  ·  cash ' + fmt.usd(d.cash)
    + (ev.length ? '  ·  ' + ev.join('; ') : '');
}

function renderAudit() {
  const days = model.days;
  $('stockouts').tBodies[0].replaceChildren(...(model.stockouts.length
    ? model.stockouts.map((w) => row([w.start, w.end, w.length, fmt.one(w.peak)], true))
    : [row(['None so far', '', '', ''])]));

  $('utilAudit').tBodies[0].replaceChildren(...model.utilization.map((u, k) => row([
    'Station ' + u.station, fmt.pct(u.allDays), fmt.pct(u.withoutStockouts),
    fmt.pct(rollingMean(days, (d) => d.util[k], 5)),
  ], true, 1)));
  const n = model.utilization[0].stockoutDays;
  $('utilNote').textContent = n
    ? n + ' of ' + days.length + ' days had jobs waiting for kits. On those days the stations were starved of work, which pulls the plain average down.'
    : 'No stockout days so far, so the two averages are the same.';

  const ev = $('events');
  ev.replaceChildren(...(model.events.length ? model.events : [{ day: null, label: 'None detected yet.' }]).map((e) => {
    const li = document.createElement('li');
    li.textContent = (e.day === null ? '' : 'Day ' + e.day + ': ') + e.label;
    return li;
  }));

  const cols = [
    ['Day', (d) => d.day], ['Accepted', (d) => d.accepted], ['Completed', (d) => d.completed],
    ['Waiting for kits', (d) => fmt.one(d.waiting)],
    ['Util St1', (d) => fmt.pct(d.util[0])], ['Util St2', (d) => fmt.pct(d.util[1])], ['Util St3', (d) => fmt.pct(d.util[2])],
    ['Queue St1', (d) => fmt.one(d.queueJobs[0])], ['Queue St2', (d) => fmt.one(d.queueJobs[1])], ['Queue St3', (d) => fmt.one(d.queueJobs[2])],
    ['Lead time', (d) => fmt.two(d.leadTime)], ['Revenue/job', (d) => fmt.usd(d.revPerJob)],
    ['In factory', (d) => d.wip], ['Kits on hand (est.)', (d) => fmt.int(d.kitsOnHand)], ['Cash', (d) => fmt.usd(d.cash)],
  ];
  const table = $('daily');
  const hr = document.createElement('tr');
  cols.forEach(([name]) => { const th = document.createElement('th'); th.scope = 'col'; th.className = 'num'; th.textContent = name; hr.append(th); });
  table.tHead.replaceChildren(hr);
  table.tBodies[0].replaceChildren(...days.slice().reverse().map((d) => row(cols.map(([, pick]) => pick(d)), true)));
}

// ---------------------------------------------------------------- small DOM helpers
function div(cls, text) { const el = document.createElement('div'); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function td(text) { const el = document.createElement('td'); el.textContent = text; return el; }
function tdNode(node) { const el = document.createElement('td'); el.append(node); return el; }
function row(values, numeric = false, firstText = 0) {
  const tr = document.createElement('tr');
  values.forEach((v, i) => { const c = td(v); if (numeric && i >= firstText) c.className = 'num'; tr.append(c); });
  return tr;
}

// ---------------------------------------------------------------- start
$('refresh').addEventListener('click', () => { load($('daySelect').value); loadDayList(); });
$('daySelect').addEventListener('change', () => load($('daySelect').value));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (model) { renderPanels(); redrawWhatIf(); } });
setupWhatIf();
setupAdvisor();
load('');
loadDayList();
