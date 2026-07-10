const { isAuthed, unauthorized } = require('./lib/auth');
const { getTabList } = require('./lib/sheets');

exports.handler = async (event) => {
  if (!isAuthed(event)) return unauthorized();
  const force = (event.queryStringParameters || {}).force === '1';
  try {
    const data = await getTabList(force);
    return { statusCode: 200,
             headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
             body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
