const { makeCookie, checkPassword } = require('./lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST required' };
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString()
    : (event.body || '');
  const pw = new URLSearchParams(body).get('password') || '';
  if (checkPassword(pw)) {
    return { statusCode: 303,
             headers: { 'Set-Cookie': makeCookie(), Location: '/' }, body: '' };
  }
  return { statusCode: 303, headers: { Location: '/login.html?error=1' }, body: '' };
};
