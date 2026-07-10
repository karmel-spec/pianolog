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

_cache = {'data': None, 'at': 0.0}
_lock = threading.Lock()

def fetch_live():
    r = subprocess.run(
        ['gog', '-a', ACCOUNT, '--json', 'sheets', 'get', SHEET_ID, RANGE],
        capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or 'gog sheets get failed')
    raw = json.loads(r.stdout)
    data = parse(raw.get('values', []))
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

    def do_GET(self):
        if self.path.startswith('/api/pianos'):
            try:
                data = get_pianos(force='force=1' in self.path)
                body = json.dumps(data, ensure_ascii=False).encode()
                self.send_response(200)
            except Exception as e:
                body = json.dumps({'error': str(e)}).encode()
                self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''):
            super().log_message(fmt, *args)

if __name__ == '__main__':
    os.makedirs(os.path.join(DIR, 'data'), exist_ok=True)
    print(f'Piano Log live server → http://localhost:{PORT}  (sheet {SHEET_ID}, cache {CACHE_TTL}s)')
    http.server.ThreadingHTTPServer(('', PORT), Handler).serve_forever()
