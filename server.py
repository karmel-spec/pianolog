#!/usr/bin/env python3
"""Piano Log live server.

Serves the webapp and a /api/pianos endpoint that reads the Piano Log &
Inventory Google Sheet (first tab) live via the `gog` CLI, so the sheet
stays the source of truth. Responses are cached in memory for CACHE_TTL
seconds; pass ?force=1 (the Refresh button) to bypass the cache.

Each successful fetch also updates data/pianolog-raw.json and
data/pianos.json, which serve as the offline fallback if Google is
unreachable.

Auth matches the deployed Netlify version: Google Sign-In with roles from
the "App Access" spreadsheet tab (admins see everything; technicians never
receive pricing or owner contact data), plus the legacy admin password.
With no password configured the app runs open as admin (local dev).

Run: python3 server.py   (port 8412)
Requires: gog authenticated as karmel@brighamlarsonpianos.com
"""
import http.server, json, os, re, secrets, subprocess, sys, threading, time
import urllib.request
from urllib.parse import urlparse, parse_qs, quote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts'))
from parse import parse  # noqa: E402

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 8412
SHEET_ID = '1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc'
RANGE = "'Piano Log'!A1:BA5000"
ACCOUNT = 'karmel@brighamlarsonpianos.com'
CACHE_TTL = 300  # seconds
TABS_TTL = 3600  # tab list changes rarely

def load_password():
    """Password comes from $PIANOLOG_PASSWORD or data/password.txt (gitignored —
    never hardcode it here; this file is on public GitHub)."""
    pw = os.environ.get('PIANOLOG_PASSWORD', '').strip()
    if pw:
        return pw
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'password.txt')
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    return None

PASSWORD = load_password()
SESSIONS = {}   # token -> {'role': 'admin'|'tech', 'email': str}; reset on restart

# --- Roles (mirrors netlify/functions/lib/auth.js) -----------------------
# Google sign-in maps an email to a role. The "App Access" spreadsheet tab
# (Email | Role | Notes) is the roster Brigham manages; company-domain
# accounts are always admin; the static fallbacks below cover everyone else.
GOOGLE_CLIENT_ID = '118454775893-17u7t3glh8eu4kffhe7b42jl71apre4f.apps.googleusercontent.com'
ADMIN_DOMAIN = 'brighamlarsonpianos.com'
ADMIN_EMAILS = [
    'brighamlarson@gmail.com',
    'brighamlarsonpianos@gmail.com',
    'pianoshop.blp@gmail.com',
]
TECH_RE = re.compile(r'@gmail\.com$', re.I)  # any gmail defaults to technician
ROSTER_TAB = 'App Access'
ROSTER_TTL = 300  # seconds; also how fast a Blocked row takes effect

# Fields technicians never receive: pricing, accounting links, and raw owner
# contact text. Keep in sync with netlify/functions/pianos.js.
TECH_HIDDEN_FIELDS = [
    'owner', 'agreements_price', 'cogs_invoice', 'down_payment_date',
    'qbo', 'isolved_job', 'qb_email', 'qb_address', 'qb_sale_date',
]

_roster = {'data': None, 'at': 0.0}
_roster_lock = threading.Lock()

def verify_google_token(credential):
    """Verify a Google Sign-In ID token; returns the verified email or None."""
    try:
        with urllib.request.urlopen(
                'https://oauth2.googleapis.com/tokeninfo?id_token=' + quote(credential),
                timeout=10) as r:
            info = json.load(r)
    except Exception:
        return None
    if info.get('aud') != GOOGLE_CLIENT_ID:
        return None
    if str(info.get('email_verified')).lower() != 'true':
        return None
    try:
        if float(info.get('exp', 0)) < time.time():
            return None
    except ValueError:
        return None
    return (info.get('email') or '').lower() or None

def normalize_roster_role(s):
    s = str(s or '').strip().lower()
    if re.match(r'^(admin|administrator|owner|full)', s):
        return 'admin'
    if re.match(r'^(tech|technician|limited)', s):
        return 'tech'
    if re.match(r'^(block|blocked|none|no access|no|off|revoked|denied)', s):
        return 'blocked'
    return None  # unrecognized -> ignore the row

def roster_roles():
    """email(lowercase) -> 'admin'|'tech'|'blocked' from the App Access tab."""
    with _roster_lock:
        if _roster['data'] is not None and time.time() - _roster['at'] < ROSTER_TTL:
            return _roster['data']
        values = gog_json('get', SHEET_ID, f"'{ROSTER_TAB}'!A1:C500").get('values', [])
        roles = {}
        for row in values:
            email = str(row[0] if row else '').strip().lower()
            if '@' not in email:
                continue  # header, blanks, the how-to note
            role = normalize_roster_role(row[1] if len(row) > 1 else '')
            if role:
                roles[email] = role
        _roster.update(data=roles, at=time.time())
        return roles

def role_for_email(email):
    """Static fallback rules (no roster)."""
    email = (email or '').lower()
    extra = [e.strip().lower() for e in os.environ.get('PIANOLOG_ADMINS', '').split(',') if e.strip()]
    if email.endswith('@' + ADMIN_DOMAIN):
        return 'admin'
    if email in ADMIN_EMAILS or email in extra:
        return 'admin'
    if TECH_RE.search(email):
        return 'tech'
    return None

def resolve_role(email):
    """Company domain first, then the sheet roster, then static fallbacks.
    Degrades to the static rules if the roster is unreachable."""
    email = (email or '').lower()
    if not email:
        return None
    if email.endswith('@' + ADMIN_DOMAIN):
        return 'admin'
    try:
        listed = roster_roles().get(email)
    except Exception:
        listed = None  # sheet unreachable -> static rules only
    if listed == 'blocked':
        return None
    if listed:
        return listed
    return role_for_email(email)

def effective_role(session):
    """Role to enforce for this request. Google sessions are re-checked
    against the roster so a Blocked row takes effect within ROSTER_TTL."""
    if not session:
        return None
    email = session.get('email', '')
    if '@' not in email:
        return session.get('role')  # password / dev-open sessions
    return resolve_role(email)

_cache = {'data': None, 'at': 0.0}
_tab_cache = {}   # title -> {'data':..., 'at':...}
_tabs_list = {'data': None, 'at': 0.0}
_lock = threading.Lock()

def gog_json(*args, timeout=90):
    r = subprocess.run(['gog', '-a', ACCOUNT, '--json', 'sheets', *args],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or 'gog failed')
    return json.loads(r.stdout)

def list_tabs(force=False):
    """Visible tabs of the spreadsheet, in sheet order."""
    if _tabs_list['data'] and time.time() - _tabs_list['at'] < TABS_TTL and not force:
        return _tabs_list['data']
    info = gog_json('info', SHEET_ID)
    tabs = []
    for s in sorted(info['sheets'], key=lambda s: s['properties'].get('index', 0)):
        p = s['properties']
        if p.get('hidden'):
            continue
        g = p.get('gridProperties', {})
        tabs.append({'title': p['title'], 'rows': g.get('rowCount', 0), 'cols': g.get('columnCount', 0)})
    _tabs_list.update(data=tabs, at=time.time())
    return tabs

def get_tab(title, force=False):
    """Generic live view of any visible tab: header row + data rows."""
    titles = {t['title'] for t in list_tabs()}
    if title not in titles:
        raise ValueError(f'unknown tab: {title}')
    c = _tab_cache.get(title)
    if c and time.time() - c['at'] < CACHE_TTL and not force:
        return c['data']
    vals = gog_json('get', SHEET_ID, title).get('values', [])
    headers, rows = [], []
    if vals:
        headers = [h.strip() for h in vals[0]]
        while headers and not headers[-1]:
            headers.pop()
        headers = headers[:60] or ['(A)']
        for i, r in enumerate(vals[1:], start=2):
            r = [c.strip() for c in r[:len(headers)]]
            if any(r):
                rows.append({'row': i, 'cells': r + [''] * (len(headers) - len(r))})
    data = {'title': title, 'headers': headers, 'rows': rows, 'live': True,
            'generated_at': time.strftime('%b %d, %Y at %I:%M %p')}
    _tab_cache[title] = {'data': data, 'at': time.time()}
    return data

def apply_owner_overlay(data):
    """Merge QuickBooks-matched owner info (scripts/match_owners.py) into
    pianos that lack owner data. Adds qb_* fields; never overwrites the sheet's
    own owner column."""
    path = os.path.join(DIR, 'data', 'owners-overlay.json')
    if not os.path.exists(path):
        return
    with open(path) as f:
        by_serial = json.load(f).get('by_serial', {})  # normalized-serial -> {qb_owner,...}
    norm = lambda s: re.sub(r'[^A-Z0-9]', '', (s or '').upper())
    has_owner = lambda p: bool(p.get('owner_name') or '@' in p.get('owner', '')
                               or re.search(r'\d{3}[-.\s)]\d', p.get('owner', '')))
    n = 0
    for p in data['pianos']:
        if has_owner(p):
            continue  # only fill pianos with no owner name, email, or phone
        m = None
        for tok in re.findall(r'[A-Z]{0,3}\d{3,}[A-Z0-9]*', (p.get('serial', '')).upper()):
            m = by_serial.get(norm(tok)) or by_serial.get(re.sub(r'\D', '', tok))
            if m:
                break
        if m:
            p['qb_owner'] = m.get('qb_owner', '')
            p['qb_sale_date'] = m.get('qb_sale_date', '')
            p['qb_email'] = m.get('qb_email', '')
            p['qb_address'] = m.get('qb_address', '')
            p['qb_city_state'] = m.get('qb_city_state', '')
            p['qb_matched_serial'] = m.get('matched_serial', '')
            n += 1
    data['qb_matched'] = n

def fetch_live():
    r = subprocess.run(
        ['gog', '-a', ACCOUNT, '--json', 'sheets', 'get', SHEET_ID, RANGE],
        capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or 'gog sheets get failed')
    raw = json.loads(r.stdout)
    data = parse(raw.get('values', []))
    apply_owner_overlay(data)
    data['live'] = True
    with open(os.path.join(DIR, 'data', 'pianolog-raw.json'), 'w') as f:
        json.dump(raw, f, ensure_ascii=False)
    with open(os.path.join(DIR, 'data', 'pianos.json'), 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    return data

def get_pianos(force=False):
    with _lock:
        fresh = _cache['data'] and (time.time() - _cache['at'] < CACHE_TTL)
        if fresh and not force:
            return _cache['data']
        try:
            data = fetch_live()
            _cache.update(data=data, at=time.time())
            return data
        except Exception as e:
            if _cache['data']:
                stale = dict(_cache['data'], live=False, error=str(e))
                return stale
            snap = os.path.join(DIR, 'data', 'pianos.json')
            if os.path.exists(snap):
                with open(snap) as f:
                    data = json.load(f)
                data.update(live=False, error=str(e))
                return data
            raise

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def get_session(self):
        """Session dict {'role','email'} or None. With no password configured
        the app runs open as admin (local dev), matching the old behavior."""
        if not PASSWORD:
            return {'role': 'admin', 'email': ''}
        for part in self.headers.get('Cookie', '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == 'plsession' and v in SESSIONS:
                return SESSIONS[v]
        return None

    def start_session(self, role, email):
        tok = secrets.token_hex(16)
        SESSIONS[tok] = {'role': role, 'email': email}
        return f'plsession={tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'

    def redirect(self, location, cookie=None):
        self.send_response(303)
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Location', location)
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path in ('/login', '/api/login'):
            n = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(n).decode()

            # Google Sign-In: JSON {credential: <ID token>} posted by login.html.
            if 'application/json' in self.headers.get('Content-Type', ''):
                try:
                    credential = json.loads(body).get('credential', '')
                except ValueError:
                    credential = ''
                email = credential and verify_google_token(credential)
                if not email:
                    return self.send_json({'ok': False,
                        'error': 'Google sign-in could not be verified.'}, 401)
                role = resolve_role(email)
                if not role:
                    return self.send_json({'ok': False,
                        'error': f'{email} is not authorized for the Piano Log. Ask Brigham to add you.'}, 403)
                cookie = self.start_session(role, email)
                body = json.dumps({'ok': True, 'role': role, 'email': email}).encode()
                self.send_response(200)
                self.send_header('Set-Cookie', cookie)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            # Legacy admin password form.
            pw = parse_qs(body).get('password', [''])[0]
            if PASSWORD and secrets.compare_digest(pw, PASSWORD):
                return self.redirect('/', cookie=self.start_session('admin', 'password-login'))
            return self.redirect('/login.html?error=1')
        self.send_response(404)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client navigated away mid-response; nothing to do

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        force = q.get('force', ['0'])[0] == '1'
        session = self.get_session()
        # Google sessions are re-checked against the roster each request, so a
        # Blocked row in the App Access tab takes effect within ROSTER_TTL.
        role = effective_role(session)
        if not role:
            if u.path in ('/login.html', '/assets/blp-logo.png'):
                return super().do_GET()
            if u.path.startswith('/api/'):
                return self.send_json({'error': 'authentication required'}, 401)
            return self.redirect('/login.html' +
                (f'?next={quote("?" + u.query)}' if u.query else ''))
        try:
            if u.path == '/api/pianos':
                data = get_pianos(force=force)
                if role == 'tech':
                    # copy, never mutate the shared cache
                    data = dict(data, pianos=[
                        {k: v for k, v in p.items() if k not in TECH_HIDDEN_FIELDS}
                        for p in data['pianos']])
                return self.send_json(dict(data, role=role))
            # Raw spreadsheet tabs can hold pricing and accounting — admins only.
            if u.path in ('/api/tabs', '/api/tab') and role != 'admin':
                return self.send_json({'error': 'The tab browser is admin-only.'}, 403)
            if u.path == '/api/tabs':
                with _lock:
                    return self.send_json({'tabs': list_tabs(force=force)})
            if u.path == '/api/tab':
                title = q.get('title', [''])[0]
                with _lock:
                    return self.send_json(get_tab(title, force=force))
        except ValueError as e:
            return self.send_json({'error': str(e)}, 404)
        except Exception as e:
            return self.send_json({'error': str(e)}, 502)
        super().do_GET()

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''):
            super().log_message(fmt, *args)

if __name__ == '__main__':
    os.makedirs(os.path.join(DIR, 'data'), exist_ok=True)
    print(f'Piano Log live server → http://localhost:{PORT}  (sheet {SHEET_ID}, cache {CACHE_TTL}s)')
    http.server.ThreadingHTTPServer(('', PORT), Handler).serve_forever()
