// Queue reorder for shopwork sections: the row order IS the work queue
// (top row = #1). POST {serial, new_pos} — this function re-reads the sheet,
// finds the piano and the piano currently at the target position, and asks
// the Apps Script bridge to move the row before/after that anchor. The move
// is serial-anchored (never raw row numbers), so concurrent row shifts can't
// misplace it. Available to technicians and admins.
const { getSession, effectiveRole, unauthorized } = require('./lib/auth');
const { getTabValues, postAppsScript, clearTabCache } = require('./lib/sheets');
const { parse } = require('./lib/parse');
const mirror = require('./lib/mirror');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const session = getSession(event);
  if (!session) return unauthorized();
  const role = await effectiveRole(session);
  if (!role) return unauthorized();
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'bad request body' }); }

  try {
    // positions must be current: the mirror copy when it was synced within
    // the last 4 min (every app write re-syncs it), else a fresh bridge read
    let data = null;
    if (mirror.configured()) {
      try {
        const m = await mirror.readPianos();
        const age = m && m.last_sync && m.last_sync.at ? Date.now() - Date.parse(m.last_sync.at) : Infinity;
        if (m && m.rows && m.rows.length && age < 4 * 60000) data = { pianos: m.rows, sections: m.sections || [] };
      } catch (e) { /* bridge below */ }
    }
    if (!data) {
      const raw = await getTabValues('Piano Log', true);  // force fresh: positions must be current
      data = parse(raw.values || []);
    }
    const target = String(body.serial || '').trim();
    if (!target) return json(409, { error: 'this entry has no serial number — add one in the sheet first' });
    const matches = data.pianos.filter(p => p.serial.trim() === target);
    if (!matches.length) return json(409, { error: 'serial not found in the sheet — refresh and try again' });
    if (matches.length > 1) return json(409, { error: 'this serial appears more than once in the sheet — reorder it in the sheet directly' });
    const p = matches[0];
    if (p.group !== 'Shopwork') return json(409, { error: 'queue ordering applies only to shopwork sections' });
    const members = data.pianos.filter(x => x.section === p.section);
    const total = members.length;
    const newPos = parseInt(body.new_pos, 10);
    if (!Number.isInteger(newPos)) return json(409, { error: 'queue number must be a whole number' });
    if (newPos < 1 || newPos > total) return json(409, { error: `queue number must be between 1 and ${total} for ${p.section}` });
    if (newPos === p.queue_pos) return json(200, { ok: true, moved: false, queue_pos: newPos, queue_total: total });
    const anchor = members[newPos - 1];
    if (!anchor.serial.trim()) {
      return json(409, { error: `the piano currently at queue #${newPos} has no serial number, so the move can't be anchored safely — reorder in the sheet` });
    }
    const res = await postAppsScript({
      action: 'move',
      serial: target,
      anchor_serial: anchor.serial.trim(),
      where: newPos > p.queue_pos ? 'after' : 'before',
    });
    if (res.error) return json(409, { error: res.error });
    clearTabCache('Piano Log');
    await mirror.triggerSync('pianolog-queue');   // row order changed → re-sync the mirror now
    return json(200, { ok: true, moved: true, queue_pos: newPos, queue_total: total, section: p.section });
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }
};
