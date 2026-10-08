// Piano Log READ MIRROR (phase 1, 10/7): the hosted app reads pianos from the
// Supabase copy of the sheet (schema pianolog, project ismacawxfvvllfinibbf,
// refreshed every ≤3 min + after every write by blpsalesapp's pianolog-sync)
// instead of waiting 3–30 s on the Apps Script bridge. The SHEET stays the
// authority; writes still go through the bridge (update.js / queue.js).
// Access is a service_role-only RPC (the rows hold customer PII, so the role
// gating in pianos.js is what stands between a tech and the owner columns).
// Env: SUPABASE_SERVICE_KEY (+ optional SUPABASE_URL) on the Netlify site.
const SB_URL = (process.env.SUPABASE_URL || 'https://ismacawxfvvllfinibbf.supabase.co').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SYNC_URL = 'https://blpsalesapp.netlify.app/.netlify/functions/pianolog-sync-background';
const SYNC_KEY = process.env.BLP_APP_ACCESS_KEY || 'pianoman';

const configured = () => !!SB_KEY;

async function rpc(name, body, timeoutMs) {
  if (!SB_KEY) throw new Error('mirror not configured (SUPABASE_SERVICE_KEY)');
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 8000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('mirror ' + name + ' ' + r.status + ': ' + txt.slice(0, 120));
  return txt ? JSON.parse(txt) : null;
}

// the RPC drops empty-string fields to halve the payload; every record gets
// the parser's full key set back so nothing downstream meets `undefined`
const { PL_COLS } = require('./pianolog-parse.cjs');
const PL_KEYS = Object.keys(PL_COLS).concat(['subsection', 'owner_name']);
function inflate(m) {
  if (m && m.compact && Array.isArray(m.rows)) {
    for (const p of m.rows) for (const k of PL_KEYS) if (!(k in p)) p[k] = '';
  }
  return m;
}

/** {rows, sections, last_sync} in the app's own record shape; rows=[] when the mirror is empty. */
const readPianos = () => rpc('pianolog_read', { p_shape: 'pl', p_active_only: false }, 10000).then(inflate);

/** meta: sections, app_access (the App Access roster rows), last_sync. */
const readMeta = () => rpc('pianolog_read', { p_shape: 'meta', p_active_only: false }, 6000);

/**
 * Optimistic patch after a confirmed bridge write, so the next read shows it
 * before the sync re-reads the sheet. `edits` is the app's [{field, new}].
 * Unknown fields are left to the sync (≤ 3 min).
 */
const RAW_HEADERS = {
  location_status: 'LOCATION / STATUS', year: 'YEAR', current_phase: 'CURRENT PHASE', summary: 'SUMMARY',
  make: 'MAKE', model: 'MODEL', size: 'SIZE', status: 'STATUS', notes: 'NOTES', project_category: 'PROJECT CATEGORY',
};
async function patchAfterUpdate(serial, edits) {
  if (!configured() || !serial) return false;
  const pl = {}, raw = {}, cols = {};
  const sm = {};
  for (const e of edits || []) {
    const v = String(e.new == null ? '' : e.new);
    pl[e.field] = v;
    if (RAW_HEADERS[e.field]) raw[RAW_HEADERS[e.field]] = v;
    if (e.field === 'current_phase') { cols.phase = v; sm.phase = v; }
    if (e.field === 'location_status') { cols.location = v; sm.location = v; sm.isSlot = /^\d+(?:\.\d)?[a-zA-Z]?$/.test(v); }
    if (e.field === 'status') { cols.status = v; sm.status = v; }
    if (e.field === 'year') sm.year = v;
    if (e.field === 'make') sm.make = v;
    if (e.field === 'model') sm.model = v;
    if (e.field === 'size') sm.size = v;
    if (e.field === 'summary') sm.summary = v;
  }
  try { return !!(await rpc('pianolog_patch', { p_serial: serial, p_cols: cols, p_sm: sm, p_pl: pl, p_raw: raw }, 6000)); }
  catch (e) { console.warn('mirror patch failed:', String(e.message || e).slice(0, 120)); return false; }
}

/** Ask blpsalesapp to re-sync the mirror now (returns once the job is accepted, ~0.2 s). */
async function triggerSync(source) {
  try {
    await fetch(SYNC_URL + '?key=' + encodeURIComponent(SYNC_KEY) + '&source=' + encodeURIComponent(source || 'pianolog-app'),
      { method: 'POST', signal: AbortSignal.timeout(6000) });
  } catch (e) { console.warn('mirror sync trigger failed:', String(e.message || e).slice(0, 120)); }
}

module.exports = { configured, readPianos, readMeta, patchAfterUpdate, triggerSync };
