const { getSession, effectiveRole, unauthorized } = require('./lib/auth');
const { getTabValues } = require('./lib/sheets');
const { parse } = require('./lib/parse');
const mirror = require('./lib/mirror');

// Fields technicians never receive: pricing, accounting links, and raw owner
// contact text. They keep owner_name (parsed first/last name) and everything
// needed for shop work. Enforced here, server-side — the browser of a
// tech-role user simply never gets this data.
const TECH_HIDDEN_FIELDS = [
  'owner',              // raw column: may contain phone/email/address lines
  'agreements_price',   // Agreements / Finance pricing
  'cogs_invoice',       // COGS / Invoice #
  'down_payment_date',
  'qbo', 'isolved_job',
  'qb_email', 'qb_address', 'qb_sale_date',  // defensive: QB overlay fields
];

const generatedAt = (d) => new Date(d || Date.now()).toLocaleString('en-US', {
  timeZone: 'America/Denver', month: 'short', day: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

/**
 * Pianos from the Supabase read mirror (≈0.3 s) — same record shape the
 * parser produces, because the sync ran the very same parser. Falls back to
 * the Apps Script bridge when the mirror is unreachable or EMPTY.
 * ?force=1 (the refresh button, and the reload after every save) also asks
 * blpsalesapp to re-sync the mirror from the sheet right away; the save path
 * has already patched the mirror row, so the reload shows the edit at once.
 */
// per-instance copy keyed by the mirror's version (newest row change): a
// repeat read on a warm instance costs one small meta call (~0.1 s) instead
// of the 3.6 MB pianos read, and never serves a version the mirror has
// moved past (every sync and every optimistic patch bumps it)
let mirrorCache = { version: null, m: null };
async function readMirrorCached() {
  let version = null;
  try { version = ((await mirror.readMeta()) || {}).version || null; } catch (e) { /* full read below */ }
  if (version && mirrorCache.m && mirrorCache.version === version) return mirrorCache.m;
  const m = await mirror.readPianos();
  if (m && m.rows && m.rows.length && m.version) mirrorCache = { version: m.version, m };
  return m;
}

async function loadData(force) {
  if (mirror.configured()) {
    try {
      if (force) await mirror.triggerSync('pianolog-refresh');
      const m = await readMirrorCached();
      if (m && m.rows && m.rows.length) {
        return {
          generated_at: generatedAt(m.last_sync && m.last_sync.at),
          source: 'Piano Log & Inventory — first tab (Piano Log), via read mirror',
          sections: m.sections || [], pianos: m.rows,
          mirror: true, mirror_synced_at: m.last_sync ? m.last_sync.at : null,
        };
      }
      console.warn('[pianos] mirror empty — falling back to the bridge');
    } catch (e) {
      console.warn('[pianos] mirror unavailable — falling back to the bridge:', String(e.message || e).slice(0, 120));
    }
  }
  const raw = await getTabValues('Piano Log', force);
  const data = parse(raw.values || []);
  data.mirror = false;
  return data;
}

exports.handler = async (event) => {
  const session = getSession(event);
  if (!session) return unauthorized();
  const role = await effectiveRole(session);   // roster re-check: revoked -> 401
  if (!role) return unauthorized();
  const force = (event.queryStringParameters || {}).force === '1';
  try {
    const t0 = Date.now();
    const data = await loadData(force);
    data.live = true;
    data.role = role;
    data.read_ms = Date.now() - t0;
    if (role === 'tech') {
      // copies, never the cached objects: a tech read must not strip the
      // instance's shared copy that the next admin read would serve
      data.pianos = data.pianos.map(p => {
        const c = { ...p };
        for (const f of TECH_HIDDEN_FIELDS) delete c[f];
        return c;
      });
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: String(e.message || e) }) };
  }
};

exports.TECH_HIDDEN_FIELDS = TECH_HIDDEN_FIELDS;
