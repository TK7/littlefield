/**
 * Littlefield Simulation 2 - A Team
 * Loads the newest Littlefield "Download" file from the Source Data folder
 * into the "Raw Data" tab of this Google Sheet.
 *
 * Version 2: after each import it also sends a snapshot to the team dashboard
 * on Cloudflare (if a dashboard connection has been set from the menu).
 *
 * Version 3 (presentation): an Extracts tab lists every download in the folder with the
 * settings in force on its day; Littlefield > Load an extract... shows any of them, and
 * Push all extracts to dashboard sends each one as a named extract.
 *
 * This file REPLACES the whole of the earlier script. The "Drive API" advanced
 * service is optional: without it, Excel files are converted through the Drive
 * REST API. After pasting, reload the Sheet and use Littlefield > Set dashboard connection.
 */

const SOURCE_FOLDER_ID = '1I0TM0ZjEQvHM2Ntv-xkChoQQLdXk6qvm'; // "Source Data - drop Littlefield downloads here"
const RAW_TAB = 'Raw Data';
const SETUP_TAB = 'Setup';
const TMP_PREFIX = '_tmp_import_';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Littlefield')
    .addItem('Import newest file now', 'importNewestForce')
    .addItem('Push to dashboard now', 'pushToDashboardNow')
    .addSeparator()
    .addItem('Load an extract...', 'showExtractPicker')
    .addItem('Back to final state', 'backToFinalState')
    .addItem('Set up the Extracts tab', 'setUpExtractsTab')
    .addItem('Push all extracts to dashboard', 'pushAllExtracts')
    .addSeparator()
    .addItem('Set dashboard connection', 'setDashboardConnection')
    .addItem('Turn on automatic import (every 15 min)', 'installTrigger')
    .addItem('Turn off automatic import', 'removeTrigger')
    .addToUi();
}

/** Runs on the timer. Skips files already imported and files with fewer days than the sheet has. */
function importNewest() {
  // While an extract is on screen, the timer must not replace it with the newest file.
  if (PropertiesService.getDocumentProperties().getProperty('viewingExtract')) return;
  runImport_(false);
  // Also runs when nothing was imported, so edits to the Settings tab reach the dashboard.
  try { pushSnapshot_(false); } catch (e) { console.error('Dashboard push failed: ' + e); }
}

/** Runs from the menu. Always loads the newest file in the folder. */
function importNewestForce() {
  let msg = runImport_(true);
  try { msg += ' ' + pushSnapshot_(true); } catch (e) { msg += ' Dashboard push failed: ' + e.message; }
  SpreadsheetApp.getActive().toast(msg, 'Littlefield import', 10);
}

function runImport_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 'Another import is running. Try again in a minute.';
  try {
    const ss = SpreadsheetApp.getActive();
    const raw = ss.getSheetByName(RAW_TAB);
    if (!raw) throw new Error('Tab "' + RAW_TAB + '" not found.');

    // 1. Find the newest spreadsheet file in the source folder.
    const folder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
    const files = folder.getFiles();
    let newest = null;
    while (files.hasNext()) {
      const f = files.next();
      const type = f.getMimeType();
      if (f.isTrashed()) continue;
      if (f.getId() === ss.getId()) continue;
      if (f.getName().indexOf(TMP_PREFIX) === 0) continue;
      if (type !== MimeType.MICROSOFT_EXCEL && type !== MimeType.GOOGLE_SHEETS) continue;
      if (!newest || f.getLastUpdated().getTime() > newest.getLastUpdated().getTime()) newest = f;
    }
    if (!newest) return 'No Excel or Google Sheets file found in the source folder.';

    const props = PropertiesService.getDocumentProperties();
    const key = newest.getId() + '|' + newest.getLastUpdated().getTime();
    if (!force && props.getProperty('lastImportKey') === key) return 'Nothing new.';

    const haveDay = dayCount_(raw.getRange(1, 1, Math.max(raw.getLastRow(), 5), 1).getValues());
    const loaded = loadFileIntoRaw_(newest, force ? 0 : haveDay);
    props.setProperty('lastImportKey', key);
    if (!loaded.ok) return loaded.message;
    return 'Imported "' + newest.getName() + '" (through Day ' + loaded.maxDay + ').';
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads a Littlefield download (Excel or Google Sheets) into columns A to X of Raw Data.
 * minDay: refuse files with fewer days than this (0 = load whatever it is).
 */
function loadFileIntoRaw_(file, minDay) {
  const ss = SpreadsheetApp.getActive();
  const raw = ss.getSheetByName(RAW_TAB);
  if (!raw) throw new Error('Tab "' + RAW_TAB + '" not found.');
  let values;
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    values = SpreadsheetApp.openById(file.getId()).getSheets()[0].getDataRange().getValues();
  } else {
    const tmpId = convertToSheet_(file);
    try {
      values = SpreadsheetApp.openById(tmpId).getSheets()[0].getDataRange().getValues();
    } finally {
      DriveApp.getFileById(tmpId).setTrashed(true);
    }
  }
  if (values.length < 5 || values[0].length < 24 || String(values[3][0]).trim() !== 'Days') {
    return { ok: false, message: 'Skipped "' + file.getName() + '": it does not look like a Littlefield download (expected "Days" in cell A4 and 24 columns).' };
  }
  values = values.map(function (row) { return row.slice(0, 24); });
  const maxDay = dayCount_(values);
  if (minDay && maxDay < minDay) {
    return { ok: false, message: 'Skipped "' + file.getName() + '": it has ' + maxDay + ' days and the sheet already has ' + minDay + '.' };
  }
  raw.getRange(1, 1, raw.getMaxRows(), 24).clearContent();
  if (raw.getMaxRows() < values.length) raw.insertRowsAfter(raw.getMaxRows(), values.length - raw.getMaxRows());
  raw.getRange(1, 1, values.length, 24).setValues(values);
  const setup = ss.getSheetByName(SETUP_TAB);
  if (setup) {
    setup.getRange('B4').setValue(file.getName());
    setup.getRange('B5').setValue(Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'EEE d MMM yyyy, h:mm a'));
    setup.getRange('B6').setValue(maxDay);
  }
  return { ok: true, maxDay: maxDay };
}

/** Highest day number found in column A (first column of a 2-D array). */
function dayCount_(rows) {
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i][0];
    if (typeof v === 'number' && v > max) max = v;
  }
  return max;
}

/**
 * Makes a temporary Google Sheets copy of an Excel file.
 * Uses the "Drive API" advanced service when it is turned on; otherwise calls the
 * Drive REST API directly with this script's own sign-in, so the service is optional.
 */
function convertToSheet_(file) {
  const name = TMP_PREFIX + file.getName();
  if (typeof Drive !== 'undefined') {
    try {
      return Drive.Files.copy({ name: name, mimeType: MimeType.GOOGLE_SHEETS }, file.getId()).id; // v3
    } catch (e) {
      try {
        return Drive.Files.copy({ title: name, mimeType: MimeType.GOOGLE_SHEETS }, file.getId(), { convert: true }).id; // v2
      } catch (e2) { /* fall through to the REST call */ }
    }
  }
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.getId()) + '/copy?supportsAllDrives=true&fields=id', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ name: name, mimeType: MimeType.GOOGLE_SHEETS }),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not convert "' + file.getName() + '" to a Google Sheet (Drive answered '
      + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText()).id;
}

function installTrigger() {
  removeTrigger_();
  ScriptApp.newTrigger('importNewest').timeBased().everyMinutes(15).create();
  SpreadsheetApp.getActive().toast('Automatic import is on: the source folder is checked every 15 minutes.', 'Littlefield import', 8);
}

function removeTrigger() {
  removeTrigger_();
  SpreadsheetApp.getActive().toast('Automatic import is off.', 'Littlefield import', 8);
}

function removeTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importNewest') ScriptApp.deleteTrigger(t);
  });
}


// ====================================================================
// Dashboard push
// ====================================================================

/** Menu: asks for the dashboard address and the shared secret, and stores them with this Sheet. */
function setDashboardConnection() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getDocumentProperties();
  const a = ui.prompt('Dashboard address',
    'Paste the dashboard address, for example https://littlefield.jay.systems\n(current: ' + (props.getProperty('dashboardUrl') || 'not set') + ')',
    ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const url = a.getResponseText().trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(url)) { ui.alert('The address must start with https://'); return; }
  const b = ui.prompt('Shared secret',
    'Paste the same value you saved in Cloudflare as INGEST_SECRET.', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const secret = b.getResponseText().trim();
  if (secret.length < 16) { ui.alert('Use a secret of at least 16 characters.'); return; }
  props.setProperty('dashboardUrl', url);
  props.setProperty('ingestSecret', secret);
  props.deleteProperty('lastPushHash');
  ui.alert('Saved. Now use Littlefield > Push to dashboard now to test it.');
}

function pushToDashboardNow() {
  let msg;
  try { msg = pushSnapshot_(true); } catch (e) { msg = 'Dashboard push failed: ' + e.message; }
  SpreadsheetApp.getActive().toast(msg, 'Littlefield dashboard', 10);
}

/**
 * Sends the snapshot if it changed since the last push (or always, when force is true).
 * extract: {slug, label, file} to store it as a named extract instead of the live snapshot.
 */
function pushSnapshot_(force, extract) {
  const props = PropertiesService.getDocumentProperties();
  const url = props.getProperty('dashboardUrl');
  const secret = props.getProperty('ingestSecret');
  if (!url || !secret) return 'Dashboard connection not set.';

  SpreadsheetApp.flush(); // make sure formulas have recalculated after an import
  const snap = buildSnapshot_(extract ? extract.day : null);
  if (extract) snap.extract = { slug: extract.slug, label: extract.label, file: extract.file };
  const body = JSON.stringify(snap);
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body));
  if (!force && !extract && props.getProperty('lastPushHash') === hash) return 'Dashboard already up to date.';

  const res = UrlFetchApp.fetch(url + '/api/ingest', {
    method: 'post',
    contentType: 'application/json',
    payload: body,
    headers: { 'x-ingest-secret': secret },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('the dashboard answered ' + code + ': ' + res.getContentText().slice(0, 200));
  }
  if (!extract) props.setProperty('lastPushHash', hash);
  return extract ? 'Extract "' + extract.label + '" pushed.' : 'Dashboard updated.';
}

/**
 * Collects everything the dashboard needs from the tabs of this Sheet.
 * upToDay: for an extract, leaderboard rows after its day are left out.
 */
function buildSnapshot_(upToDay) {
  const ss = SpreadsheetApp.getActive();
  const tab = function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) throw new Error('Tab "' + name + '" not found.');
    return sh;
  };
  const num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };
  const pairs = function (name, a1) { // label / displayed value pairs, blank labels skipped
    return tab(name).getRange(a1).getDisplayValues().filter(function (r) { return r[0] !== '' && r[1] !== ''; });
  };

  // Daily rows: columns A to X of Raw Data, from row 5, numeric day only.
  const rawSheet = tab(RAW_TAB);
  const lastRow = Math.max(rawSheet.getLastRow(), 5);
  const raw = rawSheet.getRange(5, 1, lastRow - 4, 24).getValues()
    .filter(function (r) { return typeof r[0] === 'number' && r[0] > 0; })
    .map(function (r) { return r.map(num); });

  const S = tab('Settings');
  const v = function (a1) { return S.getRange(a1).getValue(); };
  const settings = {
    team: String(v('B5')), rop: num(v('B6')), q: num(v('B7')), sched: String(v('B8')), finalPlaced: String(v('B9')),
    targets: [num(v('B12')), num(v('B13')), num(v('B14'))],
    demandPlan: num(v('B15')), z: num(v('B16')), trigger: num(v('B17')), finalDay: num(v('B18')), kitThreshold: num(v('B19')),
    kitsPerJob: num(v('B22')), kitCost: num(v('B23')), orderFee: num(v('B24')), kitLead: num(v('B25')),
    startKits: num(v('B26')), startCash: num(v('B27')), dailyRate: num(v('B28')), resale: num(v('B29')),
    wipLimit: num(v('B30')), controlEnd: num(v('B32')), gameEnd: num(v('B33')),
    contracts: S.getRange('B36:D38').getValues().map(function (r) { return { revenue: num(r[0]), quoted: num(r[1]), max: num(r[2]) }; }),
    stations: S.getRange('B44:D46').getValues().map(function (r) { return { start: num(r[0]), price: num(r[1]), ptime: num(r[2]) }; }),
  };

  const comp = tab('Competitors').getRange('A4:L44').getValues();
  const setup = tab(SETUP_TAB).getRange('B4:B6').getDisplayValues();
  const play = tab('Playbook');

  return {
    schema: 1,
    source: { file: setup[0][0], importedAt: setup[1][0], days: setup[2][0] },
    headline: play.getRange('A2:A3').getDisplayValues().map(function (r) { return r[0]; }),
    summary: pairs('Playbook', 'A6:B14'),
    playbook: play.getRange('A18:C29').getDisplayValues().filter(function (r) { return r[0] !== ''; }),
    settings: settings,
    tables: {
      capacity: tab('Capacity').getRange('A13:M16').getDisplayValues(),
      demand: pairs('Capacity', 'A4:B10'),
      mix: tab('Capacity').getRange('A26:N34').getDisplayValues(),
      contract: pairs('Contract', 'A4:B18'),
      kits: pairs('Kits', 'A4:B44'),
      cash: tab('Cash').getRange('A10:F14').getDisplayValues(),
    },
    competitors: {
      teams: comp[0].slice(1).map(String),
      rows: comp.slice(1).filter(function (r) { return typeof r[0] === 'number' && r[0] > 0 && (!upToDay || r[0] <= upToDay); })
        .map(function (r) { return r.map(num); }),
    },
    raw: raw,
  };
}


// ====================================================================
// Extracts: show any earlier download with the settings in force then
// ====================================================================

const EXTRACTS_TAB = 'Extracts';
const EXTRACT_HEADERS = ['File name', 'Label', 'Slug', 'Day', 'Reorder point', 'Order quantity',
  'Station 2 rule', 'Final order placed', 'Planning demand', 'Push to dashboard', 'Last pushed', 'Notes'];
// Settings tab cells each extract sets while it is on screen.
const SETTING_CELLS = { rop: 'B6', q: 'B7', sched: 'B8', finalPlaced: 'B9', demandPlan: 'B15' };

/**
 * The settings the team had on a given day, from the game history (to be checked by the team).
 * The order quantity changed from 26,700 to 26,100 between the orders on Days 82 and 113.
 */
function knownSettings_(day) {
  if (day <= 50) return { rop: 1440, q: 7200, sched: 'FIFO', finalPlaced: 'NO', demandPlan: 15.5, note: 'Inherited settings before the restart.' };
  if (day < 113) return { rop: 6000, q: 26700, sched: 'Step 4', finalPlaced: 'NO', demandPlan: 15.5, note: 'After the Day 51 restart moves.' };
  if (day < 198) return { rop: 6000, q: 26100, sched: 'Step 4', finalPlaced: 'NO', demandPlan: 15.5, note: 'Check: order quantity 26,100 from about Day 113.' };
  if (day <= 200) return { rop: 6000, q: 26100, sched: 'Step 4', finalPlaced: 'NO', demandPlan: 15.0, note: 'Before the final order (placed Day 200.37).' };
  return { rop: 0, q: 0, sched: 'Step 4', finalPlaced: 'YES', demandPlan: 15.0, note: 'After the final order of 53,760 kits.' };
}

function sourceFiles_() {
  const ss = SpreadsheetApp.getActive();
  const it = DriveApp.getFolderById(SOURCE_FOLDER_ID).getFiles();
  const out = [];
  while (it.hasNext()) {
    const f = it.next();
    const type = f.getMimeType();
    if (f.isTrashed() || f.getId() === ss.getId() || f.getName().indexOf(TMP_PREFIX) === 0) continue;
    if (type !== MimeType.MICROSOFT_EXCEL && type !== MimeType.GOOGLE_SHEETS) continue;
    out.push(f);
  }
  return out;
}

/** The day a download covers, from its name ("... Daily Data 198.xlsx", "Day 50", "268 Final"). */
function dayFromName_(name) {
  const m = String(name).match(/(\d{1,3})(?!.*\d)/);
  return m ? Number(m[1]) : null;
}

/** Menu: creates or refreshes the Extracts tab. Existing rows (and your edits) are kept. */
function setUpExtractsTab() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(EXTRACTS_TAB);
  if (!sh) {
    sh = ss.insertSheet(EXTRACTS_TAB);
    sh.getRange(1, 1, 1, EXTRACT_HEADERS.length).setValues([EXTRACT_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const have = {};
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { have[r[0]] = true; });
  const added = [];
  sourceFiles_().forEach(function (f) {
    if (have[f.getName()]) return;
    const day = dayFromName_(f.getName());
    const k = knownSettings_(day || 0);
    const isFinal = /final/i.test(f.getName()) || day === 268;
    const label = isFinal ? 'Final: Day ' + (day || 268) : 'Day ' + (day || '?');
    const slug = isFinal ? 'final-' + (day || 268) : 'day-' + (day || f.getId().slice(0, 6).toLowerCase());
    added.push([f.getName(), label, slug, day || '', k.rop, k.q, k.sched, k.finalPlaced, k.demandPlan, 'YES', '', k.note]);
  });
  added.sort(function (a, b) { return (a[3] || 0) - (b[3] || 0); });
  if (added.length) sh.getRange(sh.getLastRow() + 1, 1, added.length, EXTRACT_HEADERS.length).setValues(added);
  sh.autoResizeColumns(1, EXTRACT_HEADERS.length);
  SpreadsheetApp.getActive().toast(added.length + ' file(s) added. Check the settings columns against what was set in Littlefield on each day.', 'Extracts', 10);
}

function extractRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(EXTRACTS_TAB);
  if (!sh || sh.getLastRow() < 2) throw new Error('No Extracts tab yet: use Littlefield > Set up the Extracts tab.');
  return sh.getRange(2, 1, sh.getLastRow() - 1, EXTRACT_HEADERS.length).getValues().map(function (r, i) {
    return { row: i + 2, file: String(r[0]), label: String(r[1]), slug: String(r[2]), day: Number(r[3]) || null,
      settings: { rop: r[4], q: r[5], sched: r[6], finalPlaced: r[7], demandPlan: r[8] },
      push: String(r[9]).toUpperCase().indexOf('Y') === 0 };
  }).filter(function (x) { return x.file; });
}

function findFile_(name) {
  const files = sourceFiles_().filter(function (f) { return f.getName() === name; });
  if (!files.length) throw new Error('File "' + name + '" is not in the source folder.');
  return files[0];
}

/** Saves the live Settings once, before the first extract replaces them. */
function rememberLiveSettings_() {
  const props = PropertiesService.getDocumentProperties();
  if (props.getProperty('liveSettings')) return;
  const S = SpreadsheetApp.getActive().getSheetByName('Settings');
  const live = {};
  Object.keys(SETTING_CELLS).forEach(function (k) { live[k] = S.getRange(SETTING_CELLS[k]).getValue(); });
  props.setProperty('liveSettings', JSON.stringify(live));
}

function applySettings_(values) {
  const S = SpreadsheetApp.getActive().getSheetByName('Settings');
  Object.keys(SETTING_CELLS).forEach(function (k) {
    if (values[k] !== '' && values[k] !== null && values[k] !== undefined) S.getRange(SETTING_CELLS[k]).setValue(values[k]);
  });
}

/** Loads one Extracts row into Raw Data with its settings. Returns the loaded day. */
function loadExtract_(x) {
  rememberLiveSettings_();
  const loaded = loadFileIntoRaw_(findFile_(x.file), 0);
  if (!loaded.ok) throw new Error(loaded.message);
  applySettings_(x.settings);
  PropertiesService.getDocumentProperties().setProperty('viewingExtract', x.label);
  const setup = SpreadsheetApp.getActive().getSheetByName(SETUP_TAB);
  if (setup) setup.getRange('B4').setValue(x.file + '   (extract: ' + x.label + ')');
  SpreadsheetApp.flush();
  return loaded.maxDay;
}

/** Menu: a list of the Extracts tab's files to choose from. */
function showExtractPicker() {
  const rows = extractRows_();
  const items = rows.map(function (x, i) {
    return '<li><button onclick="pick(' + i + ')">' + escape_(x.label) + '</button> <span>' + escape_(x.file) + '</span></li>';
  }).join('');
  const html = HtmlService.createHtmlOutput(
    '<style>body{font:14px system-ui,sans-serif}ul{list-style:none;padding:0}li{margin:6px 0}button{min-width:140px;padding:6px 10px}span{color:#666;font-size:12px}#msg{margin-top:10px}</style>' +
    '<p>Choose a download. It is loaded into Raw Data with the settings from its Extracts row, and every tab recalculates. ' +
    'Use Littlefield &gt; Back to final state when you are done.</p><ul>' + items + '</ul><div id="msg"></div>' +
    '<script>function pick(i){document.getElementById("msg").textContent="Loading...";' +
    'google.script.run.withSuccessHandler(function(m){document.getElementById("msg").textContent=m;setTimeout(function(){google.script.host.close()},1200)})' +
    '.withFailureHandler(function(e){document.getElementById("msg").textContent=e.message}).loadExtractByIndex(i)}</script>'
  ).setWidth(460).setHeight(Math.min(560, 140 + rows.length * 40));
  SpreadsheetApp.getUi().showModalDialog(html, 'Load an extract');
}

/** Called from the picker. */
function loadExtractByIndex(i) {
  const x = extractRows_()[i];
  const day = loadExtract_(x);
  return 'Showing ' + x.label + ' (data through Day ' + day + ').';
}

/** Menu: restores the live settings and the newest download. */
function backToFinalState() {
  const props = PropertiesService.getDocumentProperties();
  const live = props.getProperty('liveSettings');
  if (live) applySettings_(JSON.parse(live));
  props.deleteProperty('liveSettings');
  props.deleteProperty('viewingExtract');
  let msg = runImport_(true);
  SpreadsheetApp.flush();
  SpreadsheetApp.getActive().toast('Back to the final state. ' + msg, 'Extracts', 8);
}

/**
 * Menu: loads every Extracts row marked "Push to dashboard" and sends it as a named extract,
 * then returns to the final state. Apps Script stops a run after 6 minutes, so a long list
 * stops early and continues where it left off when run again.
 */
function pushAllExtracts() {
  const props = PropertiesService.getDocumentProperties();
  if (!props.getProperty('dashboardUrl')) throw new Error('Set the dashboard connection first.');
  const started = Date.now();
  const sh = SpreadsheetApp.getActive().getSheetByName(EXTRACTS_TAB);
  const round = props.getProperty('pushRound') || String(started);
  props.setProperty('pushRound', round);
  const done = [], failed = [];
  let stoppedEarly = false;
  extractRows_().forEach(function (x) {
    if (!x.push || stoppedEarly) return;
    if (String(sh.getRange(x.row, 11).getNote()) === round) return;   // already pushed in this round
    if (Date.now() - started > 4.5 * 60 * 1000) { stoppedEarly = true; return; }
    try {
      const day = loadExtract_(x);
      pushSnapshot_(true, { slug: x.slug, label: x.label, file: x.file, day: day });
      sh.getRange(x.row, 11).setValue(new Date()).setNote(round);
      done.push(x.label);
    } catch (e) {
      failed.push(x.label + ': ' + e.message);
    }
  });
  backToFinalState();
  if (!stoppedEarly) props.deleteProperty('pushRound');
  SpreadsheetApp.getUi().alert('Pushed: ' + (done.join(', ') || 'none') +
    (failed.length ? '\n\nFailed:\n' + failed.join('\n') : '') +
    (stoppedEarly ? '\n\nStopped early to stay inside the time limit. Run Push all extracts again to continue.' : ''));
}

function escape_(t) {
  return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
