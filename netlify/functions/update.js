// Write-back endpoint for the hosted app: forwards {serial, edits} to the
// Apps Script bridge, which locates the row by serial (never row position)
// and verify-then-writes each cell. See apps-script/Code.gs doPost.
// Admin-only: technicians never receive the pricing/owner fields, so they
// could never verify-then-write correctly — and shouldn't write at all.
const { getSession, effectiveRole, unauthorized, forbidden } = require('./lib/auth');
const { postAppsScript, clearTabCache } = require('./lib/sheets');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const session = getSession(event);
  if (!session) return unauthorized();
  const role = await effectiveRole(session);   // roster re-check: revoked -> 401
  if (!role) return unauthorized();
  if (role !== 'admin') return forbidden('Editing from the app is admin-only.');
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
