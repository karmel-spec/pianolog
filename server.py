#!/usr/bin/env python3
"""Piano Log live server.

Serves the webapp and a /api/pianos endpoint that reads the Piano Log &
Inventory Google Sheet (first tab) live via the `gog` CLI, so the sheet
stays the source of truth. Responses are cached in memory for CACHE_TTL
seconds; pass ?force=1 (the Refresh button) to bypass the cache.

Each successful fetch also updates data/pianolog-raw.json and
data/pianos.json, which serve as the offline fallback if Google is
unreachable.

Run: python3 server.py   (port 8412)
Requires: gog authenticated as karmel@brighamlarsonpianos.com
"""
import http.server, json, os, re, secrets, subprocess, sys, threading, time
from urllib.parse import urlparse, parse_qs

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
SESSIONS = set()   # valid session tokens (reset on server restart)

LOGIN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Piano Log</title>
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Assistant',sans-serif;background:#121212;min-height:100vh;
       display:flex;align-items:center;justify-content:center;padding:1.5rem}
  .card{background:#fff;border-radius:8px;padding:2.5rem 2.2rem;max-width:380px;width:100%;text-align:center}
  .card img{width:240px;max-width:100%}
  .rule{display:flex;align-items:center;margin:1.4rem 0}
  .rule .bar{flex:1;height:2px;background:#9e2020}
  .rule .dot{width:7px;height:7px;border-radius:50%;background:#9e2020;margin:0 5px}
  h1{font-size:.8rem;letter-spacing:.24em;text-transform:uppercase;color:#4a4a4a;font-weight:600}
  input{width:100%;margin-top:1.2rem;padding:.75rem 1rem;font-size:1rem;font-family:inherit;
        border:1px solid #bbb;border-radius:6px}
  input:focus{outline:2px solid #9e2020;border-color:transparent}
  button{width:100%;margin-top:.8rem;padding:.8rem;background:#9e2020;color:#fff;border:none;
         border-radius:6px;font-size:.9rem;letter-spacing:.14em;text-transform:uppercase;
         font-family:inherit;cursor:pointer}
  button:hover{background:#b43333}
  .err{margin-top:.9rem;color:#9e2020;font-size:.85rem}
</style></head><body>
<form class="card" method="post" action="/login">
  <img src="/assets/blp-logo.png" alt="Brigham Larson Pianos">
  <div class="rule"><div class="bar"></div><div class="dot"></div><div class="bar"></div></div>
  <h1>Piano Log &amp; Inventory</h1>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  {{ERROR}}
</form></body></html>"""

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

    def is_authed(self):
        if not PASSWORD:
            return True
        for part in self.headers.get('Cookie', '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == 'plsession' and v in SESSIONS:
                return True
        return False

    def send_login(self, error=False, status=200):
        body = LOGIN_HTML.replace('{{ERROR}}',
            '<div class="err">Incorrect password — try again.</div>' if error else '').encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path in ('/login', '/api/login'):
            n = int(self.headers.get('Content-Length', 0))
            pw = parse_qs(self.rfile.read(n).decode()).get('password', [''])[0]
            if PASSWORD and secrets.compare_digest(pw, PASSWORD):
                tok = secrets.token_hex(16)
                SESSIONS.add(tok)
                self.send_response(303)
                self.send_header('Set-Cookie',
                    f'plsession={tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000')
                self.send_header('Location', '/')
                self.end_headers()
            else:
                self.send_login(error=True)
            return
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
        if not self.is_authed():
            if u.path == '/assets/blp-logo.png':   # the login page needs the logo
                return super().do_GET()
            if u.path.startswith('/api/'):
                return self.send_json({'error': 'authentication required'}, 401)
            return self.send_login()
        try:
            if u.path == '/api/pianos':
                return self.send_json(get_pianos(force=force))
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
