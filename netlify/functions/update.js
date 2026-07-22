// Write-back endpoint for the hosted app: forwards {serial, edits} to the
// Apps Script bridge, which locates the row by serial (never row position)
// and verify-then-writes each cell. See apps-script/Code.gs doPost.
const { isAuthed, unauthorized } = require('./lib/auth');
const { postAppsScript, clearTabCache } = require('./lib/sheets');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (!isAuthed(event)) return unauthorized();
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'bad request body' }); }
  try {
    const data = await postAppsScript({
      action: 'update',
      serial: body.serial,
      edits: body.edits || [],
    });
    if (data.error) return json(409, { error: data.error });
    clearTabCache('Piano Log');  // next read must see the new values
    return json(200, data);
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
};
