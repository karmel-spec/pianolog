const { makeCookie, checkPassword, verifyGoogleToken, roleForEmail } = require('./lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST required' };
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString()
    : (event.body || '');

  // Google Sign-In: JSON {credential: <ID token>} posted by login.html.
  if ((event.headers['content-type'] || '').includes('application/json')) {
    let credential = '';
    try { credential = JSON.parse(body).credential || ''; } catch (e) { /* fall through */ }
    const email = credential && await verifyGoogleToken(credential);
    if (!email) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ ok: false, error: 'Google sign-in could not be verified.' }) };
    }
    const role = roleForEmail(email);
    if (!role) {
      return { statusCode: 403, headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ ok: false, error: `${email} is not authorized for the Piano Log. Ask Brigham to add you.` }) };
    }
    return { statusCode: 200,
             headers: { 'Set-Cookie': makeCookie(role, email), 'Content-Type': 'application/json' },
             body: JSON.stringify({ ok: true, role, email }) };
  }

  // Legacy admin password form (rotate PIANOLOG_PASSWORD — technicians knew the old one).
  const pw = new URLSearchParams(body).get('password') || '';
  if (checkPassword(pw)) {
    return { statusCode: 303,
             headers: { 'Set-Cookie': makeCookie('admin', 'password-login'), Location: '/' }, body: '' };
  }
  return { statusCode: 303, headers: { Location: '/login.html?error=1' }, body: '' };
};
