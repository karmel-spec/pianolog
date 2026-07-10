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
import http.server, json, os, subprocess, sys, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts'))
from parse import parse  # noqa: E402

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 8412
SHEET_ID = '1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc'
RANGE = "'Piano Log'!A1:BA5000"
ACCOUNT = 'karmel@brighamlarsonpianos.com'
CACHE_TTL = 300  # seconds
TABS_TTL = 3600  # tab list changes rarely

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
        overlay = json.load(f)
    by_row = {v['sheet_row']: v for v in overlay.values() if not v.get('conflict')}
    n = 0
    for p in data['pianos']:
        m = by_row.get(p['sheet_row'])
        if m and not p.get('owner_name'):
            p['qb_owner'] = m['qb_customer']
            p['qb_sale_date'] = m.get('qb_date', '')
            p['qb_doc'] = m.get('qb_doc', '')
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

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        q = parse_qs(u.query)
        force = q.get('force', ['0'])[0] == '1'
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
