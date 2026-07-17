const { getSession, unauthorized, forbidden } = require('./lib/auth');
const { getTabValues, getTabList } = require('./lib/sheets');

exports.handler = async (event) => {
  const session = getSession(event);
  if (!session) return unauthorized();
  // Raw spreadsheet tabs can hold pricing and accounting — admins only.
  if (session.role !== 'admin') return forbidden('The tab browser is admin-only.');
  const q = event.queryStringParameters || {};
  const title = q.title || '';
  const force = q.force === '1';
  try {
    const { tabs } = await getTabList(false);
    if (!tabs.some(t => t.title === title)) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ error: `unknown tab: ${title}` }) };
    }
    const vals = (await getTabValues(title, force)).values || [];
    let headers = [], rows = [];
    if (vals.length) {
      headers = vals[0].map(h => String(h).trim());
      while (headers.length && !headers[headers.length - 1]) headers.pop();
      headers = headers.slice(0, 60);
      if (!headers.length) headers = ['(A)'];
      vals.slice(1).forEach((r, i) => {
        const cells = r.slice(0, headers.length).map(c => String(c).trim());
        if (cells.some(Boolean)) {
          while (cells.length < headers.length) cells.push('');
          rows.push({ row: i + 2, cells });
        }
      });
    }
    const generated_at = new Date().toLocaleString('en-US', {
      timeZone: 'America/Denver', month: 'short', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true });
    return { statusCode: 200,
             headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
             body: JSON.stringify({ title, headers, rows, live: true, generated_at }) };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
