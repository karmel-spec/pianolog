// Stateless signed-cookie auth for the Netlify functions.
// Cookie: plsession=<timestamp>.<hmac(timestamp)>, valid 30 days.
const crypto = require('crypto');

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function secret() {
  return process.env.SESSION_SECRET || process.env.PIANOLOG_PASSWORD || '';
}

function sign(ts) {
  return crypto.createHmac('sha256', secret()).update(String(ts)).digest('hex');
}

function makeCookie() {
  const ts = Date.now();
  return `plsession=${ts}.${sign(ts)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`;
}

function isAuthed(event) {
  if (!process.env.PIANOLOG_PASSWORD) return true;  // no password configured -> open
  const header = event.headers.cookie || event.headers.Cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
    if (k !== 'plsession') continue;
    const dot = v.indexOf('.');
    if (dot < 0) continue;
    const ts = v.slice(0, dot), mac = v.slice(dot + 1);
    if (!ts || !mac || Date.now() - Number(ts) > MAX_AGE_MS) continue;
    const expect = sign(ts);
    try {
      if (mac.length === expect.length &&
          crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return true;
    } catch (e) { /* malformed cookie */ }
  }
  return false;
}

function checkPassword(pw) {
  const want = process.env.PIANOLOG_PASSWORD || '';
  const a = Buffer.from(String(pw)), b = Buffer.from(want);
  return want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const unauthorized = () => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ error: 'authentication required' }),
});

module.exports = { makeCookie, isAuthed, checkPassword, unauthorized };
