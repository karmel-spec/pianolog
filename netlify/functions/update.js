// Write-back endpoint for the hosted app: forwards {serial, edits} to the
// Apps Script bridge, which locates the row by serial (never row position)
// and verify-then-writes each cell. See apps-script/Code.gs doPost.
// Role-aware: technicians may edit only their whitelist (map location, year,
// current phase — enforced again in the bridge); admins edit everything.
const { getSession, effectiveRole, unauthorized } = require('./lib/auth');
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
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'bad request body' }); }
  // Defense in depth: enforce the tech whitelist here as well as in the
  // bridge, so a stale bridge deployment can never widen tech access.
  const TECH_FIELDS = ['location_status', 'year', 'current_phase'];
  if (role === 'tech') {
    const bad = (body.edits || []).find(e => !TECH_FIELDS.includes(e.field));
    if (bad) return json(409, { error: `field "${bad.field}" is not editable from the app for technicians` });
  }
  try {
    const data = await postAppsScript({
      action: 'update',
      role,
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
