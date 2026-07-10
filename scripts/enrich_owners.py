#!/usr/bin/env python3
"""Enrich the owner cells previously written by write_owners.py with contact
info (phone, email, address incl. city/state) from the QuickBooks contact list.

Safety model: a cell is rewritten ONLY if its current content is exactly what
write_owners.py wrote ("{name}\n[Added from QuickBooks — sold {date}, s/n {serial}]")
— i.e. untouched by any human since. Anything else is skipped and logged.

Reads data/write-owners.log to find the rows we wrote, joins each to the
enriched data/owners-overlay.json, and appends contact lines above the tag.
Logs to data/enrich-owners.log.
"""
import json, os, re, subprocess, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEET = '1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc'
ACCT = 'karmel@brighamlarsonpianos.com'
LOG = os.path.join(ROOT, 'data', 'enrich-owners.log')
norm = lambda s: re.sub(r'[^A-Z0-9]', '', (s or '').upper())

def gog(*args, timeout=30):
    r = subprocess.run(['gog', '-a', ACCT, '--json', 'sheets', *args],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout) if r.stdout.strip() else {}

def main():
    overlay = json.load(open(os.path.join(ROOT, 'data', 'owners-overlay.json')))['by_serial']
    # rows we previously wrote: "WRITE B1732 <- Simko, Brenda (s/n 330576, sold 08/26/2020)"
    targets = []
    pat = re.compile(r'^WRITE B(\d+) <- (.*) \(s/n (\S+), sold ([\d/]+)\)')
    for line in open(os.path.join(ROOT, 'data', 'write-owners.log')):
        m = pat.match(line.strip())
        if m:
            targets.append({'row': int(m.group(1)), 'owner': m.group(2),
                            'mserial': m.group(3), 'date': m.group(4)})
    # row 1679 was written during the initial single-cell test, before the batch log
    targets.append({'row': 1679, 'owner': 'Matt Wittwer', 'mserial': '166462', 'date': '11/06/2020'})

    log = open(LOG, 'w')
    written = skipped = 0
    for i, t in enumerate(targets, 1):
        entry = overlay.get(norm(t['mserial'])) or overlay.get(re.sub(r'\D', '', t['mserial']))
        if not entry:
            log.write(f"SKIP  B{t['row']} no-overlay-entry {t['mserial']}\n"); skipped += 1; continue
        contact_lines = [x for x in (
            re.sub(r'^(Phone|Mobile):', '', entry.get('qb_phone', '')).strip(),
            entry.get('qb_email', '').strip(),
            entry.get('qb_address', '').strip()) if x]
        if not contact_lines:
            log.write(f"SKIP  B{t['row']} no-contact-info for {t['owner']}\n"); skipped += 1; continue

        expected = f"{t['owner']}\n[Added from QuickBooks — sold {t['date']}, s/n {t['mserial']}]"
        new_value = (t['owner'] + '\n' + '\n'.join(contact_lines) +
                     f"\n[Added from QuickBooks — sold {t['date']}, s/n {t['mserial']}]")
        rng = f"'Piano Log'!B{t['row']}"
        try:
            cur = gog('get', SHEET, rng).get('values', [['']])
            cur_val = cur[0][0] if cur and cur[0] else ''
        except Exception as e:
            log.write(f"SKIP  B{t['row']} read-error {e}\n"); skipped += 1; continue
        if cur_val == new_value:
            log.write(f"SKIP  B{t['row']} already-enriched\n"); skipped += 1; continue
        if cur_val != expected:
            log.write(f"SKIP  B{t['row']} cell-modified-since-write ({cur_val[:40]!r})\n")
            skipped += 1; continue
        try:
            gog('update', SHEET, rng, '--input', 'RAW', '--values-json', json.dumps([[new_value]]))
            log.write(f"WRITE B{t['row']} enriched {t['owner']} (+{len(contact_lines)} contact lines)\n")
            written += 1
        except Exception as e:
            log.write(f"FAIL  B{t['row']} {e}\n"); skipped += 1
        if i % 25 == 0:
            log.flush(); print(f"{i}/{len(targets)} — {written} enriched, {skipped} skipped")
        time.sleep(1.0)
    log.write(f"\nDONE written={written} skipped={skipped}\n")
    log.close()
    print(f"DONE: {written} enriched, {skipped} skipped. Log: {LOG}")

if __name__ == '__main__':
    main()
