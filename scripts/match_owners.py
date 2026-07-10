#!/usr/bin/env python3
"""Match QuickBooks sales history to Piano Log serials and build an
owner-info overlay for pianos missing owner data.

Input (either):
  - CSV export(s) from QuickBooks with at least a customer-name column and a
    description/memo column (e.g. Sales by Customer Detail, Invoice List).
    Column names are detected case-insensitively.
  - JSON file of invoices: [{"customer": ..., "date": ..., "doc": ...,
    "amount": ..., "description": ...}, ...]

Usage:
  python3 scripts/match_owners.py <export1.csv> [export2.csv ...]

Output:
  - data/owners-overlay.json  — serial -> QuickBooks owner info (merged into
    /api/pianos by server.py; stays local, never committed)
  - data/owners-review.csv    — every match with confidence, for human review
    and for pasting owner info back into the Piano Log sheet
"""
import csv, json, os, re, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# serial tokens: 4+ alphanumerics with at least 4 digits, not a year or price
TOKEN = re.compile(r'\b[A-Z]{0,2}\d{4,7}[A-Z]{0,2}\b', re.I)

def tokens(text):
    out = set()
    for t in TOKEN.findall(text or ''):
        digits = re.sub(r'\D', '', t)
        if len(digits) < 4:
            continue
        if len(digits) == 4 and 1800 <= int(digits) <= 2035:
            continue  # looks like a year
        out.add(t.upper())
    return out

def load_pianos():
    with open(os.path.join(ROOT, 'data', 'pianos.json')) as f:
        return json.load(f)['pianos']

def has_owner(p):
    o = p.get('owner', '')
    return bool(p.get('owner_name') or '@' in o or re.search(r'\d{3}[-.\s)]\d', o))

def read_csv_records(path):
    """Yield {customer, date, doc, amount, description} from a QB CSV export,
    tolerating QB's title rows before the header."""
    with open(path, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.reader(f))
    hdr_i = next((i for i, r in enumerate(rows)
                  if sum(1 for c in r if c.strip()) >= 3
                  and any('name' in c.lower() or 'customer' in c.lower() for c in r)), None)
    if hdr_i is None:
        raise SystemExit(f'{path}: could not find a header row with a customer/name column')
    hdr = [h.strip().lower() for h in rows[hdr_i]]
    def col(*keys):
        for k in keys:
            for i, h in enumerate(hdr):
                if k in h:
                    return i
        return None
    c_cust = col('customer full name', 'customer', 'name')
    c_desc = col('description', 'memo', 'memo/description')
    c_date = col('date')
    c_doc = col('num', 'no.', 'invoice')
    c_amt = col('amount', 'total')
    for r in rows[hdr_i + 1:]:
        get = lambda i: r[i].strip() if i is not None and i < len(r) else ''
        rec = {'customer': get(c_cust), 'date': get(c_date), 'doc': get(c_doc),
               'amount': get(c_amt), 'description': get(c_desc)}
        if rec['customer'] or rec['description']:
            yield rec

def read_records(paths):
    for p in paths:
        if p.lower().endswith('.json'):
            with open(p) as f:
                yield from json.load(f)
        else:
            yield from read_csv_records(p)

def main(paths):
    pianos = load_pianos()
    by_token = defaultdict(list)
    for p in pianos:
        for t in tokens(p.get('serial', '')):
            by_token[t].append(p)

    overlay, review = {}, []
    for rec in read_records(paths):
        text = ' '.join(str(rec.get(k, '')) for k in ('description', 'doc', 'customer'))
        for t in tokens(rec.get('description', '') or text):
            hits = by_token.get(t)
            if not hits:
                continue
            unique = len(hits) == 1
            for p in hits:
                missing = not has_owner(p)
                conf = ('high' if unique and missing else
                        'ambiguous-serial' if not unique else 'already-has-owner')
                review.append({
                    'serial_token': t, 'sheet_row': p['sheet_row'],
                    'piano': p['summary'][:60], 'section': p['section'],
                    'existing_owner': p.get('owner_name', ''),
                    'qb_customer': rec.get('customer', ''),
                    'qb_date': rec.get('date', ''), 'qb_doc': rec.get('doc', ''),
                    'qb_amount': rec.get('amount', ''), 'confidence': conf,
                })
                if unique and missing:
                    cur = overlay.get(t)
                    if cur and cur['qb_customer'] != rec.get('customer', ''):
                        cur['conflict'] = True
                        continue
                    overlay[t] = {
                        'qb_customer': rec.get('customer', ''),
                        'qb_date': rec.get('date', ''),
                        'qb_doc': rec.get('doc', ''),
                        'qb_amount': rec.get('amount', ''),
                        'sheet_row': p['sheet_row'],
                    }

    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    with open(os.path.join(ROOT, 'data', 'owners-overlay.json'), 'w') as f:
        json.dump(overlay, f, ensure_ascii=False, indent=1)
    with open(os.path.join(ROOT, 'data', 'owners-review.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(review[0].keys()) if review else
                           ['serial_token', 'sheet_row', 'piano', 'section', 'existing_owner',
                            'qb_customer', 'qb_date', 'qb_doc', 'qb_amount', 'confidence'])
        w.writeheader()
        w.writerows(review)
    clean = sum(1 for v in overlay.values() if not v.get('conflict'))
    print(f'{len(review)} serial hits -> {clean} clean matches for pianos missing owners')
    print('wrote data/owners-overlay.json and data/owners-review.csv')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
