// Presentation panels: competitor tracking, the simulator-drift history, and the final-order
// size check. They redraw whenever a snapshot is shown (the lf:rendered event).

import { competitorData } from './advisor.js';
import { simCall, whatIfState } from './whatif.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const usd = (v) => (v === null || v === undefined ? 'n/a' : (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US'));
const signed = (v) => (v === null || v === undefined ? 'n/a' : (v >= 0 ? '+' : '−') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US'));
const int = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-US'));
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const cell = (tr, text, num) => { const td = document.createElement('td'); td.textContent = text; if (num) td.className = 'num'; tr.append(td); };

let charts = { comp: null, drift: null, size: null };
let shown = null;   // { snap, model }
let driftGen = 0;

// ------------------------------------------------------------------ competitors
function drawCompetitors(snap) {
  const comp = snap.competitors || {};
  const teams = comp.teams || [];
  const rows = (comp.rows || []).slice().sort((a, b) => a[0] - b[0]);
  const ours = (snap.settings && snap.settings.team) || 'ATeam';
  const day = snap.latestDay;
  $('compNote').textContent = rows.length
    ? 'Leaderboard cash typed into the Sheet\'s Competitors tab on Days ' + rows.map((r) => r[0]).join(', ')
      + '. The Littlefield download has only our own cash, so these rows are as fresh as the last one entered.'
    : 'No leaderboard rows in the Competitors tab yet.';
  const muted = css('--text-muted'), grid = css('--grid'), ink = css('--text-primary'), us = css('--series-b');
  const ds = teams.map((name, i) => {
    const pts = rows.filter((r) => r[i + 1] > 0).map((r) => ({ x: r[0], y: r[i + 1] }));
    const mine = name === ours;
    return { label: name, data: pts, borderColor: mine ? us : muted, backgroundColor: mine ? us : muted,
      borderWidth: mine ? 3 : 1.25, pointRadius: mine ? 3 : 1.5, tension: 0, order: mine ? 0 : 1 };
  });
  if (charts.comp) charts.comp.destroy();
  charts.comp = new Chart($('compChart'), {
    type: 'line', data: { datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: { legend: { display: false },
        tooltip: { itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: { title: (it) => 'Day ' + it[0].parsed.x, label: (it) => ' ' + it.dataset.label + ': ' + usd(it.parsed.y) } } },
      scales: {
        x: { type: 'linear', min: rows.length ? rows[0][0] : 50, max: Math.max(rows.length ? rows[rows.length - 1][0] : day, (rows.length ? rows[0][0] : 50) + 10), ticks: { color: muted, maxRotation: 0 }, grid: { display: false }, border: { color: grid } },
        y: { ticks: { color: muted, maxTicksLimit: 5, callback: (v) => '$' + (v / 1e6).toFixed(1) + 'M' }, grid: { color: grid }, border: { display: false } },
      },
    },
    plugins: [{
      id: 'endLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save(); ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
        chart.data.datasets.forEach((d, i) => {
          const meta = chart.getDatasetMeta(i);
          const p = meta.data[meta.data.length - 1];
          if (!p || d.label !== ours) return;
          ctx.fillStyle = ink; ctx.textAlign = 'right';
          ctx.fillText(d.label, p.x - 8, p.y - 10);
        });
        ctx.restore();
      },
    }],
  });
  const data = competitorData(snap, day);
  const body = $('compTable').tBodies[0];
  if (!data.teams) {
    const tr = document.createElement('tr'); cell(tr, data.note || 'Not enough leaderboard rows.'); tr.firstChild.colSpan = 6; body.replaceChildren(tr);
    return;
  }
  body.replaceChildren(...data.teams.map((t) => {
    const tr = document.createElement('tr');
    if (t.ours) tr.className = 'ours-row';
    cell(tr, t.cashLatest ? String(t.rank) : '—');
    cell(tr, t.team);
    cell(tr, t.cashLatest ? usd(t.cashLatest) + (t.asOfDay && t.asOfDay !== data.latestRowDay ? ' (Day ' + t.asOfDay + ')' : '') : 'not entered', true);
    cell(tr, t.missing ? '—' : signed(t.cashChangePerDayLatestInterval), true);
    cell(tr, t.nearestSignatureLatestInterval || '—');
    cell(tr, t.largestRecentDrop ? usd(t.largestRecentDrop.cashChange) + ', Days ' + t.largestRecentDrop.betweenDays.join('-') : '—');
    return tr;
  }));
}

// ------------------------------------------------------------------ simulator drift
async function drawDrift(snap) {
  const gen = ++driftGen;
  $('driftStatus').textContent = 'Replaying the real game under each version of the model…';
  let d;
  try { d = await simCall('drift', { snap }); } catch (e) { $('driftStatus').textContent = 'Drift check failed: ' + e.message; return; }
  if (gen !== driftGen) return;
  if (!d.versions.length) { $('driftStatus').textContent = d.note; $('driftTable').tBodies[0].replaceChildren(); if (charts.drift) charts.drift.destroy(); return; }
  $('driftStatus').textContent = 'Days ' + d.first + '-' + d.last + ' on the $1,250 contract, replayed with the real daily orders, machines and kit orders. 16 runs a version.';
  const body = $('driftTable').tBodies[0];
  body.replaceChildren(...d.versions.map((v, i) => {
    const w = v.whole;
    const tr = document.createElement('tr');
    if (i === d.versions.length - 1) tr.className = 'ours-row';
    cell(tr, v.label);
    cell(tr, v.adopted);
    cell(tr, 'St2 ' + v.cv[1] + ', St3 ' + v.cv[2] + ', step 2 share ' + v.step2Share);
    cell(tr, usd(w.revSim) + ' (' + usd(w.revP10) + '-' + usd(w.revP90) + ')', true);
    cell(tr, usd(w.revReal), true);
    cell(tr, ordinal(Math.round(w.revPercentile * 100)), true);
    cell(tr, w.leadSim.toFixed(3) + ' / ' + w.leadReal.toFixed(3), true);
    return tr;
  }));
  const labels = d.blocks.map(([a, b]) => 'Days ' + a + '-' + b);
  const first = d.versions[0], last = d.versions[d.versions.length - 1];
  const muted = css('--text-muted'), grid = css('--grid');
  if (charts.drift) charts.drift.destroy();
  charts.drift = new Chart($('driftChart'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Real game', data: last.byBlock.map((b) => b && b.revReal), backgroundColor: css('--text-primary') },
      { label: first.label + ' (first model)', data: first.byBlock.map((b) => b && b.revSim), backgroundColor: css('--series-2') },
      { label: last.label + ' (final model)', data: last.byBlock.map((b) => b && b.revSim), backgroundColor: css('--series-b') },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'bottom', labels: { color: muted, boxWidth: 12, font: { size: 11.5 } } },
        tooltip: { callbacks: { label: (it) => ' ' + it.dataset.label + ': ' + usd(it.parsed.y) } } },
      scales: {
        x: { ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { display: false }, border: { color: grid } },
        y: { min: 1000, max: 1250, ticks: { color: muted, callback: (v) => '$' + v.toLocaleString('en-US') }, grid: { color: grid }, border: { display: false },
             title: { display: true, text: 'Revenue per job', color: muted } },
      },
    },
  });
}

// ------------------------------------------------------------------ final order size check
export async function drawSizeSweep() {
  const st = whatIfState();
  if (!st || !st.deck) return;
  const f = st.final;
  const day = f && f.rows && f.rows.length ? f.rows[0].day : null;
  if (!day) { $('sizeStatus').textContent = 'The final order window has closed for this extract.'; return; }
  $('sizeStatus').textContent = 'Simulating 11 sizes × 150 runs, order placed on Day ' + day + '…';
  const r = await simCall('sizeSweep', { settings: st.deck, day });
  if (!r.rows.length) { $('sizeStatus').textContent = 'No order would go through on Day ' + day + ' with these settings.'; return; }
  $('sizeStatus').textContent = 'Order placed on Day ' + day + ', demand ' + r.demand.toFixed(1) + ' jobs a day. The model\'s own size: '
    + r.modelBatches + ' batches. Bars: average Day 268 cash against the best size.';
  if (document.body.classList.contains('presenting')) $('h-size').scrollIntoView({ block: 'start', behavior: 'smooth' });
  const muted = css('--text-muted'), grid = css('--grid');
  if (charts.size) charts.size.destroy();
  charts.size = new Chart($('sizeChart'), {
    type: 'bar',
    data: { labels: r.rows.map((x) => x.batches + ' (' + int(x.kits) + ')'),
      datasets: [{ label: 'Average Day 268 cash against the best size', data: r.rows.map((x) => x.vsBest),
        backgroundColor: r.rows.map((x) => (x.vsBest > -500 ? css('--series-b') : css('--series-solo'))) }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { title: (it) => it[0].label + ' kits', label: (it) => {
          const x = r.rows[it.dataIndex];
          return [' ' + signed(x.vsBest) + ' against the best', ' median ' + usd(x.p50) + ', bad case ' + usd(x.p10), ' runs short in the last days: ' + Math.round(x.shortShare * 100) + '%'];
        } } } },
      scales: {
        x: { title: { display: true, text: 'Batches of 60 (kits)', color: muted }, ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { display: false }, border: { color: grid } },
        y: { ticks: { color: muted, callback: (v) => signed(v) }, grid: { color: grid }, border: { display: false } },
      },
    },
  });
}

// ------------------------------------------------------------------ wiring
document.addEventListener('lf:rendered', (e) => {
  shown = e.detail;
  drawCompetitors(shown.snap);
  drawDrift(shown.snap);
  $('sizeStatus').textContent = 'Press "Check the size" to compare order sizes around the model\'s own.';
  if (charts.size) { charts.size.destroy(); charts.size = null; }
});
$('sizeRun').addEventListener('click', () => drawSizeSweep());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (shown) { drawCompetitors(shown.snap); drawDrift(shown.snap); } });
