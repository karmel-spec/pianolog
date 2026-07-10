const { isAuthed, unauthorized } = require('./lib/auth');
const { getTabValues } = require('./lib/sheets');
const { parse } = require('./lib/parse');

exports.handler = async (event) => {
  if (!isAuthed(event)) return unauthorized();
  const force = (event.queryStringParameters || {}).force === '1';
  try {
    const raw = await getTabValues('Piano Log', force);
    const data = parse(raw.values || []);
    data.live = true;
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
