#!/usr/bin/env python3
"""Write QuickBooks-matched owner names into BLANK owner cells of the Piano Log.

Safety model:
  - Only fills cells that are currently EMPTY (never overwrites existing data).
  - Verify-then-write: re-reads each target cell (owner col B + serial col C)
    immediately before writing and only writes if B is still blank AND the
    serial still matches the expected one — so row shifts from concurrent edits
    can't cause a mis-write.
  - Logs every action to data/write-owners.log for a full audit / undo trail.

Input: scratchpad/write-safe.json  (list of {row, serial, owner, date, mserial})
Run:   python3 scripts/write_owners.py
"""
import json, os, re, subprocess, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEET = '1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc'
ACCT = 'karmel@brighamlarsonpianos.com'
TARGETS = '/private/tmp/claude-501/-Users-ivorylarson/3836a728-e545-45e6-a7f1-08a17b524037/scratchpad/write-safe.json'
LOG = os.path.join(ROOT, 'data', 'write-owners.log')
norm = lambda s: re.sub(r'[^A-Z0-9]', '', (s or '').upper())

def gog(*args, timeout=30):
    r = subprocess.run(['gog', '-a', ACCT, '--json', 'sheets', *args],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout) if r.stdout.strip() else {}

def cell_value(vals, r, c):
    if r < len(vals) and c < len(vals[r]):
        return str(vals[r][c]).strip()
    return ''

def main():
    targets = json.load(open(TARGETS))
    log = open(LOG, 'w')
    written = skipped = 0
    for i, t in enumerate(targets, 1):
        row = t['row']
        rng = f"'Piano Log'!B{row}:C{row}"
        try:
            cur = gog('get', SHEET, rng).get('values', [[]])
            owner_now = cur[0][0].strip() if cur and len(cur[0]) > 0 else ''
            serial_now = cur[0][1].strip() if cur and len(cur[0]) > 1 else ''
        except Exception as e:
            log.write(f"SKIP  B{row} read-error {e}\n"); skipped += 1; continue

        toks = {norm(x) for x in re.findall(r'[A-Z]{0,3}\d{3,}[A-Z0-9]*', serial_now.upper())}
        toks |= {re.sub(r'\D', '', x) for x in re.findall(r'\d{3,}', serial_now)}
        if owner_now != '':
            log.write(f"SKIP  B{row} no-longer-blank ({owner_now[:30]!r})\n"); skipped += 1; continue
        if norm(t['mserial']) not in toks and re.sub(r'\D', '', t['mserial']) not in toks:
            log.write(f"SKIP  B{row} serial-mismatch now={serial_now[:20]!r} exp={t['mserial']!r}\n")
            skipped += 1; continue

        value = f"{t['owner']}\n[Added from QuickBooks — sold {t['date']}, s/n {t['mserial']}]"
        try:
            gog('update', SHEET, f"'Piano Log'!B{row}", '--input', 'RAW',
                '--values-json', json.dumps([[value]]))
            log.write(f"WRITE B{row} <- {t['owner']} (s/n {t['mserial']}, sold {t['date']})\n")
            written += 1
        except Exception as e:
            log.write(f"FAIL  B{row} write-error {e}\n"); skipped += 1
        if i % 25 == 0:
            log.flush()
            print(f"{i}/{len(targets)} processed — {written} written, {skipped} skipped")
        time.sleep(1.0)
    log.write(f"\nDONE written={written} skipped={skipped}\n")
    log.close()
    print(f"DONE: {written} written, {skipped} skipped. Log: {LOG}")

if __name__ == '__main__':
    main()
