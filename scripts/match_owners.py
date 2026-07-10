#!/usr/bin/env python3
"""Match QuickBooks sales history to Piano Log serials and build an owner
overlay for pianos missing owner data.

Inputs (from QuickBooks Online → Reports, exported as CSV):
  1. "Sales by Customer Detail" (All Dates) — REQUIRED. Customer names are
     group rows; each line's Product/Service + Description carry the piano
     serial (usually "#12345"). This maps serial -> customer + sale date.
  2. "Customer Contact List" — OPTIONAL. Adds email / address / city+state
     per customer, joined by customer name.

Usage:
  python3 scripts/match_owners.py "Sales by Customer Detail.csv" \
      ["Customer Contact List.csv"]

Output (both gitignored — they contain customer PII):
  data/owners-overlay.json  — {"by_serial": {"<normserial>": {qb_owner, ...}}}
                              merged into /api/pianos by server.py for pianos
                              with no owner name, email, or phone.
  data/owners-review.csv    — every serial match with a confidence flag, for
                              human review before trusting/writing back.
"""
import csv, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERIAL_HASH = re.compile(r'#\s*([A-Z]{0,3}\d{3,}[A-Z0-9]*)', re.I)
norm = lambda s: re.sub(r'[^A-Z0-9]', '', (s or '').upper())

def read_grouped_csv(path):
    """QuickBooks report CSVs have title rows, then a header row, then
    customer group rows (name in col 0, rest blank) followed by detail rows."""
    rows = list(csv.reader(open(path, encoding='utf-8-sig')))
    hdr_i = next(i for i, r in enumerate(rows)
                 if 'Transaction date' in r or 'Transaction type' in r)
    return rows[hdr_i + 1:]

def parse_sales(path):
    """serial(normalized) -> {customer, date} for serials mapping to one customer."""
    by_serial = {}
    cust = None
    for r in read_grouped_csv(path):
        if len(r) < 6:
            continue
        if r[0].strip() and not r[1].strip():
            cust = r[0].strip()
            continue
        prod, desc, date = r[4] if len(r) > 4 else '', r[5] if len(r) > 5 else '', r[1]
        if not re.search(r'pianos? for sale', prod, re.I):
            continue
        for m in SERIAL_HASH.finditer(prod + ' ' + desc):
            tok = m.group(1)
            if len(re.sub(r'\D', '', tok)) < 4:
                continue
            by_serial.setdefault(norm(tok), {'serials': set(), 'recs': []})
            by_serial[norm(tok)]['serials'].add(tok)
            by_serial[norm(tok)]['recs'].append({'customer': cust, 'date': date})
    return by_serial

def parse_contacts(path):
    """customer full name -> {email, address, city_state}."""
    contacts = {}
    rows = list(csv.reader(open(path, encoding='utf-8-sig')))
    hdr_i = next(i for i, r in enumerate(rows) if 'Customer full name' in r or 'Email' in r)
    hdr = [h.strip().lower() for h in rows[hdr_i]]
    col = lambda *k: next((i for i, h in enumerate(hdr) if any(x in h for x in k)), None)
    c_name, c_email, c_addr = col('customer full name', 'customer'), col('email'), col('bill address', 'address')
    c_phone = col('phone')
    for r in rows[hdr_i + 1:]:
        get = lambda i: r[i].strip() if i is not None and i < len(r) else ''
        name = get(c_name)
        if name:
            contacts[name] = {'email': get(c_email), 'address': get(c_addr),
                              'phone': get(c_phone)}
    return contacts

def latest(recs):
    def k(r):
        m = re.match(r'(\d+)/(\d+)/(\d+)', r['date'] or '')
        return (int(m.group(3)), int(m.group(1)), int(m.group(2))) if m else (0, 0, 0)
    return sorted(recs, key=k)[-1]

def main(sales_csv, contacts_csv=None):
    sales = parse_sales(sales_csv)
    contacts = parse_contacts(contacts_csv) if contacts_csv else {}

    overlay, review = {}, []
    for key, info in sales.items():
        custs = sorted(set(r['customer'] for r in info['recs']))
        rec = latest(info['recs'])
        serial = sorted(info['serials'])[0]
        conf = 'HIGH' if len(custs) == 1 else 'AMBIGUOUS'
        review.append({'matched_serial': serial, 'qb_customer': ' | '.join(custs),
                       'qb_sale_date': rec['date'], 'confidence': conf})
        if len(custs) != 1:
            continue
        c = contacts.get(custs[0], {})
        entry = {'qb_owner': custs[0], 'qb_sale_date': rec['date'], 'matched_serial': serial,
                 'qb_email': c.get('email', ''), 'qb_address': c.get('address', ''),
                 'qb_phone': c.get('phone', ''), 'qb_city_state': ''}
        overlay[key] = entry
        digits = re.sub(r'\D', '', serial)
        if digits and digits != key:
            overlay.setdefault(digits, entry)

    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    with open(os.path.join(ROOT, 'data', 'owners-overlay.json'), 'w') as f:
        json.dump({'by_serial': overlay}, f, ensure_ascii=False)
    with open(os.path.join(ROOT, 'data', 'owners-review.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['matched_serial', 'qb_customer', 'qb_sale_date', 'confidence'])
        w.writeheader(); w.writerows(review)
    print(f'{len(sales)} serials in QBO sales; {sum(1 for r in review if r["confidence"]=="HIGH")} '
          f'unique-customer serials in overlay; {len(contacts)} contacts joined.')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
