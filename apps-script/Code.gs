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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
