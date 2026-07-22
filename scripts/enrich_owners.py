#!/usr/bin/env python3
"""Enrich owner cells with QBO contact info — SCAN-BASED (row-shift proof).

Re-fetches the live sheet and finds every owner cell that still contains only
the name + our provenance tag ("{name}\n[Added from QuickBooks — sold {date},
s/n {serial}]") with no contact lines yet. For each, looks up the serial in the
enriched overlay and rewrites the cell as name + phone/email/address + tag.

Idempotent and safe: only cells matching that exact name+tag shape are touched;
once enriched (contact lines present) they no longer match and are left alone.
Logs to data/enrich-owners.log.
"""
import json, os, re, subprocess, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEET = '1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc'
ACCT = 'karmel@brighamlarsonpianos.com'
LOG = os.path.join(ROOT, 'data', 'enrich-owners.log')
norm = lambda s: re.sub(r'[^A-Z0-9]', '', (s or '').upper())
# a cell that is exactly: name line(s) + one provenance tag line, nothing else
TAG = re.compile(r'^(?P<name>.*)\n\[Added from QuickBooks — sold (?P<date>[\d/]+), s/n (?P<serial>\S+)\]$', re.S)

def gog(*args, timeout=60):
    r = subprocess.run(['gog', '-a', ACCT, '--json', 'sheets', *args],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout) if r.stdout.strip() else {}

def main():
    overlay = json.load(open(os.path.join(ROOT, 'data', 'owners-overlay.json')))['by_serial']
    vals = gog('get', SHEET, "'Piano Log'!B1:B5000").get('values', [])
    log = open(LOG, 'w')
    written = skipped = 0
    pending = []
    for i, row in enumerate(vals):
        cell = row[0] if row else ''
        m = TAG.match(cell)
        if not m or '\n' in m.group('name'):   # name must be a single line + tag only
            continue
        serial = m.group('serial')
        entry = overlay.get(norm(serial)) or overlay.get(re.sub(r'\D', '', serial))
        if not entry:
            continue
        contact = [x for x in (
            re.sub(r'^(Phone|Mobile):\s*', '', entry.get('qb_phone', '')).strip(),
            entry.get('qb_email', '').strip(), entry.get('qb_address', '').strip()) if x]
        if not contact:
            continue
        new_val = f"{m.group('name')}\n" + '\n'.join(contact) + \
                  f"\n[Added from QuickBooks — sold {m.group('date')}, s/n {serial}]"
        pending.append((i + 1, m.group('name'), new_val, len(contact)))

    log.write(f"found {len(pending)} name-only QBO cells to enrich\n")
    for n, (rownum, name, new_val, nlines) in enumerate(pending, 1):
        try:
            gog('update', SHEET, f"'Piano Log'!B{rownum}", '--input', 'RAW',
                '--values-json', json.dumps([[new_val]]))
            log.write(f"WRITE B{rownum} {name} (+{nlines} contact lines)\n")
            written += 1
        except Exception as e:
            log.write(f"FAIL  B{rownum} {e}\n"); skipped += 1
        if n % 25 == 0:
            log.flush(); print(f"{n}/{len(pending)} — {written} enriched")
        time.sleep(1.0)
    log.write(f"\nDONE written={written} failed={skipped}\n")
    log.close()
    print(f"DONE: {written} enriched, {skipped} failed. Log: {LOG}")

if __name__ == '__main__':
    main()
