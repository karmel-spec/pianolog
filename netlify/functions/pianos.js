const { getSession, effectiveRole, unauthorized } = require('./lib/auth');
const { getTabValues } = require('./lib/sheets');
const { parse } = require('./lib/parse');

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

exports.handler = async (event) => {
  const session = getSession(event);
  if (!session) return unauthorized();
  const role = await effectiveRole(session);   // roster re-check: revoked -> 401
  if (!role) return unauthorized();
  const force = (event.queryStringParameters || {}).force === '1';
  try {
    const raw = await getTabValues('Piano Log', force);
    const data = parse(raw.values || []);
    data.live = true;
    data.role = role;
    if (role === 'tech') {
      for (const p of data.pianos) {
        for (const f of TECH_HIDDEN_FIELDS) delete p[f];
      }
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
