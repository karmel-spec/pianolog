// Auth for the Netlify functions: Google Sign-In (role-based) with a legacy
// admin-password fallback. Stateless signed cookie, valid 30 days.
// Cookie: plsession=<ts>.<role>.<email-b64url>.<hmac>
const crypto = require('crypto');

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const GOOGLE_CLIENT_ID =
  '118454775893-17u7t3glh8eu4kffhe7b42jl71apre4f.apps.googleusercontent.com';

// Full access: company-domain accounts + the owner gmails. Extend with the
// PIANOLOG_ADMINS env var (comma-separated emails) — no code change needed.
const ADMIN_DOMAIN = 'brighamlarsonpianos.com';
const ADMIN_EMAILS = [
  'brighamlarson@gmail.com',
  'brighamlarsonpianos@gmail.com',
  'pianoshop.blp@gmail.com',
];
// Restricted access: technician accounts (firstlast.blp@gmail.com).
const TECH_RE = /^[a-z0-9.]+\.blp@gmail\.com$/i;

function roleForEmail(email) {
  email = String(email || '').toLowerCase();
  const extraAdmins = (process.env.PIANOLOG_ADMINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (email.endsWith('@' + ADMIN_DOMAIN)) return 'admin';
  if (ADMIN_EMAILS.includes(email) || extraAdmins.includes(email)) return 'admin';
  if (TECH_RE.test(email)) return 'tech';
  return null;  // not authorized
}

/** Verify a Google Sign-In ID token; returns the verified email or null. */
async function verifyGoogleToken(credential) {
  const r = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return null;
  const info = await r.json();
  if (info.aud !== GOOGLE_CLIENT_ID) return null;
  if (info.email_verified !== 'true' && info.email_verified !== true) return null;
  if (Number(info.exp) * 1000 < Date.now()) return null;
  return String(info.email || '').toLowerCase() || null;
}

function secret() {
  return process.env.SESSION_SECRET || process.env.PIANOLOG_PASSWORD || '';
}

const b64u = (s) => Buffer.from(String(s)).toString('base64url');
const unb64u = (s) => { try { return Buffer.from(String(s), 'base64url').toString(); } catch (e) { return ''; } };

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function makeCookie(role, email) {
  const payload = `${Date.now()}.${role}.${b64u(email || '')}`;
  return `plsession=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`;
}

/** Returns {role, email} for a valid session cookie, else null. */
function getSession(event) {
  if (!secret()) return { role: 'admin', email: '' };  // nothing configured -> open (local dev)
  const header = event.headers.cookie || event.headers.Cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== 'plsession') continue;
    const v = part.slice(eq + 1).trim();
    const bits = v.split('.');
    if (bits.length !== 4) continue;                    // old-format cookies: re-login
    const [ts, role, emailB64, mac] = bits;
    if (!ts || Date.now() - Number(ts) > MAX_AGE_MS) continue;
    if (role !== 'admin' && role !== 'tech') continue;
    const expect = sign(`${ts}.${role}.${emailB64}`);
    try {
      if (mac.length === expect.length &&
          crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) {
        return { role, email: unb64u(emailB64) };
      }
    } catch (e) { /* malformed cookie */ }
  }
  return null;
}

const isAuthed = (event) => !!getSession(event);

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

const forbidden = (msg) => ({
  statusCode: 403,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ error: msg || 'not allowed for this role' }),
});

module.exports = { makeCookie, isAuthed, getSession, checkPassword,
                   verifyGoogleToken, roleForEmail, unauthorized, forbidden };
