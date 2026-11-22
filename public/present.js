// Present mode: steps through public/story.js. Each step loads its extract, shows only its
// panels and puts the talking points in the presenter bar. Keys: right/left arrow or
// PageDown/PageUp to move, Escape to leave.

import { CHAPTERS, RESULT } from './story.js';
import { drawSizeSweep } from './panels.js';

const $ = (id) => document.getElementById(id);
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
const STEPS = CHAPTERS.flatMap((c, ci) => c.steps.map((s, si) => ({ ...s, chapter: c.title, ci, si, of: c.steps.length })));

let at = -1;
let extracts = null;   // slugs available, once listed
let pendingSize = false;
let shownSelection = null;   // what the page shows now
let whatifReadyFor = null;   // the selection the what-if results belong to

function panelsFor(step) {
  return step.show.map((p) => (p === 'size' ? 'whatif' : p));
}

function show(i) {
  at = Math.max(0, Math.min(STEPS.length - 1, i));
  const step = STEPS[at];
  document.body.classList.add('presenting');
  const on = new Set(panelsFor(step));
  document.querySelectorAll('[data-panel]').forEach((el) => el.classList.toggle('on', on.has(el.dataset.panel)));
  $('pChapter').textContent = 'Chapter ' + (step.ci + 1) + ' of ' + CHAPTERS.length + ': ' + step.chapter;
  $('pTitle').textContent = step.title;
  $('pCount').textContent = (at + 1) + ' / ' + STEPS.length;
  const missing = extracts && !extracts.includes(step.extract);
  const items = [...step.bullets];
  if (missing) items.unshift('The "' + step.extract + '" extract has not been pushed yet. In the Sheet: Littlefield > Push all extracts to dashboard.');
  $('pBullets').replaceChildren(...items.map((t, k) => {
    const li = document.createElement('li'); li.textContent = t; if (missing && k === 0) li.className = 'warn'; return li;
  }));
  $('pPrev').disabled = at === 0;
  $('pNext').disabled = at === STEPS.length - 1;
  renderMap();
  pendingSize = step.show.includes('size');
  const want = 'x:' + step.extract;
  if (pendingSize && shownSelection === want && whatifReadyFor === want) { pendingSize = false; drawSizeSweep(); }
  if (!missing) document.dispatchEvent(new CustomEvent('lf:select', { detail: want }));
  window.scrollTo({ top: 0 });
  const url = new URL(location.href);
  url.searchParams.set('present', String(at + 1));
  history.replaceState(null, '', url);
}

function renderMap() {
  $('pMap').replaceChildren(...CHAPTERS.map((c, ci) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (ci + 1) + '. ' + c.title;
    b.className = STEPS[at] && STEPS[at].ci === ci ? 'current' : '';
    b.addEventListener('click', () => show(STEPS.findIndex((s) => s.ci === ci)));
    return b;
  }));
}

function exit() {
  document.body.classList.remove('presenting');
  document.querySelectorAll('[data-panel]').forEach((el) => el.classList.remove('on'));
  const url = new URL(location.href);
  url.searchParams.delete('present');
  history.replaceState(null, '', url);
  at = -1;
}

// The result card: final cash, rank and the gap to second place from the leaderboard row
// for the last day, against what was projected after the final order.
function drawResult(snap, model) {
  const last = model.days[model.days.length - 1];
  const gameEnd = (snap.settings && snap.settings.gameEnd) || 268;
  const sec = $('secResult');
  sec.hidden = last.day < gameEnd;
  if (sec.hidden) return;
  const comp = snap.competitors || {};
  const row = (comp.rows || []).find((r) => r[0] === last.day);
  const ours = (snap.settings && snap.settings.team) || 'ATeam';
  let rankText = 'Enter the final leaderboard as a Day ' + last.day + ' row in the Competitors tab to show the ranking.';
  if (row) {
    const standings = (comp.teams || []).map((t, i) => ({ t, c: row[i + 1] })).filter((x) => x.c > 0).sort((a, b) => b.c - a.c);
    const rank = standings.findIndex((x) => x.t === ours) + 1;
    const next = standings[rank] || null;
    rankText = rank ? 'Rank ' + rank + ' of ' + standings.length + ' teams entered.'
      + (rank === 1 && next ? ' Ahead of ' + next.t + ' by ' + usd(standings[0].c - next.c) + '.' : '') : rankText;
  }
  $('rCash').textContent = usd(last.cash);
  $('rRank').textContent = rankText;
  const inside = last.cash >= RESULT.projectedP10 && last.cash <= RESULT.projectedP90;
  $('rProjection').textContent = 'Projected on Day ' + RESULT.projectedFrom + ': median ' + usd(RESULT.projectedP50) + ', 10-90% range '
    + usd(RESULT.projectedP10) + ' to ' + usd(RESULT.projectedP90) + '. Actual: ' + usd(last.cash)
    + (inside ? ', inside the range.' : ', outside the range.');
  $('rNote').textContent = RESULT.note;
}

export function setupPresent() {
  $('presentBtn').addEventListener('click', () => show(at >= 0 ? at : 0));
  $('pPrev').addEventListener('click', () => show(at - 1));
  $('pNext').addEventListener('click', () => show(at + 1));
  $('pExit').addEventListener('click', exit);
  document.addEventListener('keydown', (e) => {
    if (at < 0 || e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(at + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(at - 1); }
    if (e.key === 'Escape' && $('advisor').hidden) exit();
  });
  document.addEventListener('lf:extracts', (e) => {
    extracts = e.detail.map((x) => x.slug);
    if (at >= 0) show(at);
  });
  document.addEventListener('lf:rendered', (e) => { shownSelection = e.detail.selection; whatifReadyFor = null; drawResult(e.detail.snap, e.detail.model); });
  document.addEventListener('lf:whatif-ready', () => {
    whatifReadyFor = shownSelection;
    if (pendingSize && at >= 0) { pendingSize = false; drawSizeSweep(); }
  });
  const p = Number(new URLSearchParams(location.search).get('present'));
  if (p) show(p - 1);
}
