/**
 * Piano Log data bridge — deploy as a Web App from script.google.com.
 *
 * Serves the Piano Log & Inventory spreadsheet as JSON to the Netlify
 * functions (netlify/functions/lib/sheets.js). Access requires the shared
 * secret, so only the Netlify site can read it.
 *
 * Setup (once):
 *   1. Go to script.google.com (signed in as karmel@brighamlarsonpianos.com)
 *      -> New project. Paste this file. Name it "Piano Log Bridge".
 *   2. Replace SYNC_SECRET below with the value from data/deploy-secrets.txt
 *      (never commit the real secret — this repo is public).
 *   3. Deploy -> New deployment -> type: Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Authorize when prompted, then copy the Web app URL.
 *   4. In Netlify: set env vars APPS_SCRIPT_URL (that URL) and
 *      SHEETS_SYNC_SECRET (same secret as step 2).
 */

var SHEET_ID = '1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc';
var SYNC_SECRET = 'PASTE_SECRET_HERE';

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!SYNC_SECRET || SYNC_SECRET === 'PASTE_SECRET_HERE' || p.key !== SYNC_SECRET) {
    return json_({ error: 'unauthorized' });
  }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  if (p.list === '1') {
    var tabs = ss.getSheets().filter(function (s) { return !s.isSheetHidden(); })
      .map(function (s) {
        return { title: s.getName(), rows: s.getMaxRows(), cols: s.getMaxColumns() };
      });
    return json_({ tabs: tabs });
  }
  var sh = ss.getSheetByName(p.tab || 'Piano Log');
  if (!sh || sh.isSheetHidden()) return json_({ error: 'unknown tab: ' + (p.tab || '') });
  return json_({ values: sh.getDataRange().getDisplayValues() });
}

/**
 * Write-back: POST JSON with the shared key.
 *   {key, action:'update', role, serial, edits:[{field,old,new}]}   cell edits
 *   {key, action:'move', serial, anchor_serial, where}              queue reorder
 * Rows are located by exact serial-cell match (col C) at write time — never
 * by a remembered row number, since rows shift as pianos are added/removed.
 * Cell edits re-verify each field's old value before anything is written; any
 * mismatch aborts the whole save. Moves are serial-anchored: "put S before/
 * after T". Keep the WRITABLE maps in sync with server.py.
 */
var TECH_WRITABLE = {
  location_status: 20,   // map location #
  year: 4,
  current_phase: 118     // col DO
};
var WRITABLE = {
  location_status: 20, year: 4, current_phase: 118,
  owner: 1, summary: 3, make: 5, model: 6, size: 7,
  finish: 10, sheen: 11, trim: 12, status: 18,
  entry_exit_dates: 21, project_category: 23, agreements_price: 25,
  notes: 26, completion_date: 27
};

function findRowBySerial_(vals, serial) {
  var target = String(serial || '').trim();
  if (!target) return { error: 'this entry has no serial number — add one in the sheet first, then edit here' };
  var matches = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][2] || '').trim() === target) matches.push(i + 1);
  }
  if (matches.length === 0) return { error: 'serial not found in the sheet — it may have been changed; refresh and try again' };
  if (matches.length > 1) return { error: 'this serial appears in ' + matches.length + ' rows of the sheet (rows ' + matches.join(', ') + ') — edit it in the sheet directly' };
  return { row: matches[0] };
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ error: 'bad request body' }); }
  if (!SYNC_SECRET || SYNC_SECRET === 'PASTE_SECRET_HERE' || body.key !== SYNC_SECRET) {
    return json_({ error: 'unauthorized' });
  }
  if (body.action !== 'update' && body.action !== 'move') {
    return json_({ error: 'unknown action' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Piano Log');
    if (!sh) return json_({ error: 'Piano Log tab not found' });
    var vals = sh.getDataRange().getDisplayValues();

    var found = findRowBySerial_(vals, body.serial);
    if (found.error) return json_(found);
    var rownum = found.row, row = vals[rownum - 1];

    if (body.action === 'move') {
      if (String(body.anchor_serial || '').trim() === String(body.serial || '').trim()) {
        return json_({ ok: true, row: rownum, moved: false });
      }
      var anchor = findRowBySerial_(vals, body.anchor_serial);
      if (anchor.error) return json_({ error: 'anchor piano: ' + anchor.error });
      var dest = anchor.row + (body.where === 'after' ? 1 : 0);
      sh.moveRows(sh.getRange(rownum, 1), dest);
      SpreadsheetApp.flush();
      return json_({ ok: true, moved: true, from_row: rownum, anchor_row: anchor.row });
    }

    var writable = body.role === 'tech' ? TECH_WRITABLE : WRITABLE;
    var edits = body.edits || [];
    if (!edits.length) return json_({ error: 'no changes to save' });
    var checked = [];   // [0-based col, value] pairs, written only if ALL verify
    for (var j = 0; j < edits.length; j++) {
      var f = edits[j].field;
      // The serial is the row key, so it gets special rules: admin-only,
      // never blank, and never a duplicate of another row's serial.
      if (f === 'serial') {
        if (body.role === 'tech') return json_({ error: 'the serial number is admin-only — it identifies the row' });
        var newSer = String(edits[j]['new'] || '').trim();
        if (!newSer) return json_({ error: "the serial can't be blank — it's how the app finds this piano" });
        if (/^=/.test(newSer)) return json_({ error: 'values starting with "=" (formulas) can\'t be entered from the app' });
        for (var d = 0; d < vals.length; d++) {
          if (d + 1 !== rownum && String(vals[d][2] || '').trim() === newSer) {
            return json_({ error: 'serial "' + newSer + '" already belongs to row ' + (d + 1) + " — two pianos can't share a serial" });
          }
        }
        checked.push([2, newSer]);
        continue;
      }
      if (!writable.hasOwnProperty(f)) {
        return json_({ error: 'field "' + f + '" is not editable from the app' +
          (body.role === 'tech' && WRITABLE.hasOwnProperty(f) ? ' for technicians' : '') });
      }
      var newVal = String(edits[j]['new'] || '');
      if (/^\s*=/.test(newVal)) return json_({ error: 'values starting with "=" (formulas) can\'t be entered from the app' });
      var current = String(row[writable[f]] || '').trim();
      if (current !== String(edits[j].old || '').trim()) {
        return json_({ error: '"' + f + '" was changed in the sheet after you loaded it — refresh and re-apply your edit' });
      }
      checked.push([writable[f], newVal]);
    }
    for (var k = 0; k < checked.length; k++) {
      sh.getRange(rownum, checked[k][0] + 1).setValue(checked[k][1]);
    }
    SpreadsheetApp.flush();
    var updated = edits.map(function (x) { return x.field; });
    return json_({ ok: true, row: rownum, updated: updated });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
