/**
 * Littlefield Simulation 2 - A Team
 * Loads the newest Littlefield "Download" file from the Source Data folder
 * into the "Raw Data" tab of this Google Sheet.
 *
 * Version 2: after each import it also sends a snapshot to the team dashboard
 * on Cloudflare (if a dashboard connection has been set from the menu).
 *
 * This file REPLACES the whole of the earlier script. The "Drive API" service
 * added for version 1 is still needed. After pasting, reload the Sheet and use
 * Littlefield > Set dashboard connection.
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
    .addItem('Set dashboard connection', 'setDashboardConnection')
    .addItem('Turn on automatic import (every 15 min)', 'installTrigger')
    .addItem('Turn off automatic import', 'removeTrigger')
    .addToUi();
}

/** Runs on the timer. Skips files already imported and files with fewer days than the sheet has. */
function importNewest() {
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

    // 2. Read its first tab (convert Excel to a temporary Google Sheet first).
    let values;
    if (newest.getMimeType() === MimeType.GOOGLE_SHEETS) {
      values = SpreadsheetApp.openById(newest.getId()).getSheets()[0].getDataRange().getValues();
    } else {
      const tmpId = convertToSheet_(newest);
      try {
        values = SpreadsheetApp.openById(tmpId).getSheets()[0].getDataRange().getValues();
      } finally {
        DriveApp.getFileById(tmpId).setTrashed(true);
      }
    }

    // 3. Check it looks like a Littlefield download.
    if (values.length < 5 || values[0].length < 24 || String(values[3][0]).trim() !== 'Days') {
      props.setProperty('lastImportKey', key);
      return 'Skipped "' + newest.getName() + '": it does not look like a Littlefield download (expected "Days" in cell A4 and 24 columns).';
    }
    values = values.map(function (row) { return row.slice(0, 24); });
    const maxDay = dayCount_(values);
    const haveDay = dayCount_(raw.getRange(1, 1, Math.max(raw.getLastRow(), 5), 1).getValues());
    if (!force && maxDay < haveDay) {
      props.setProperty('lastImportKey', key);
      return 'Skipped "' + newest.getName() + '": it has ' + maxDay + ' days and the sheet already has ' + haveDay + '.';
    }

    // 4. Replace columns A to X of the Raw Data tab.
    raw.getRange(1, 1, raw.getMaxRows(), 24).clearContent();
    if (raw.getMaxRows() < values.length) raw.insertRowsAfter(raw.getMaxRows(), values.length - raw.getMaxRows());
    raw.getRange(1, 1, values.length, 24).setValues(values);

    // 5. Record what was loaded.
    const setup = ss.getSheetByName(SETUP_TAB);
    if (setup) {
      setup.getRange('B4').setValue(newest.getName());
      setup.getRange('B5').setValue(Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'EEE d MMM yyyy, h:mm a'));
      setup.getRange('B6').setValue(maxDay);
    }
    props.setProperty('lastImportKey', key);
    return 'Imported "' + newest.getName() + '" (through Day ' + maxDay + ').';
  } finally {
    lock.releaseLock();
  }
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

/** Makes a temporary Google Sheets copy of an Excel file. Needs the Drive API service. */
function convertToSheet_(file) {
  const name = TMP_PREFIX + file.getName();
  try {
    // Drive API v3
    return Drive.Files.copy({ name: name, mimeType: MimeType.GOOGLE_SHEETS }, file.getId()).id;
  } catch (e) {
    // Drive API v2
    return Drive.Files.copy({ title: name, mimeType: MimeType.GOOGLE_SHEETS }, file.getId(), { convert: true }).id;
  }
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

/** Sends the snapshot if it changed since the last push (or always, when force is true). */
function pushSnapshot_(force) {
  const props = PropertiesService.getDocumentProperties();
  const url = props.getProperty('dashboardUrl');
  const secret = props.getProperty('ingestSecret');
  if (!url || !secret) return 'Dashboard connection not set.';

  SpreadsheetApp.flush(); // make sure formulas have recalculated after an import
  const body = JSON.stringify(buildSnapshot_());
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body));
  if (!force && props.getProperty('lastPushHash') === hash) return 'Dashboard already up to date.';

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
  props.setProperty('lastPushHash', hash);
  return 'Dashboard updated.';
}

/** Collects everything the dashboard needs from the tabs of this Sheet. */
function buildSnapshot_() {
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
      rows: comp.slice(1).filter(function (r) { return typeof r[0] === 'number' && r[0] > 0; })
        .map(function (r) { return r.map(num); }),
    },
    raw: raw,
  };
}
