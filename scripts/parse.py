#!/usr/bin/env python3
"""Parse the raw Piano Log sheet values into clean JSON for the webapp.

Usage: python3 scripts/parse.py  (reads data/pianolog-raw.json, writes data/pianos.json)
"""
import json, os, re
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'pianolog-raw.json')
OUT = os.path.join(ROOT, 'data', 'pianos.json')

COLS = {
    'updated_at': 0, 'owner': 1, 'serial': 2, 'summary': 3, 'year': 4,
    'make': 5, 'model': 6, 'size': 7, 'published': 8, 'category': 9,
    'finish': 10, 'sheen': 11, 'trim': 12, 'before_photos': 13,
    'after_photos': 15, 'before_video': 16, 'after_video': 17,
    'status': 18, 'bench': 19, 'location_status': 20, 'entry_exit_dates': 21,
    'receiving_exiting': 22, 'project_category': 23, 'cogs_invoice': 24,
    'agreements_price': 25, 'notes': 26, 'completion_date': 27,
    'isolved_job': 28, 'qbo': 29, 'tags': 30,
    'down_payment_date': 32, 'milestones': 35,
}

# Map section headings to a coarse group used for top-level filtering
GROUPS = [
    (r'CUSTOM SHOPWORK EXITED|SOLD|EXITED', 'Sold / Exited'),
    (r'^\(WEB\)', 'Web Archive'),
    (r'SHOPWORK|NEW / QUESTIONS|ORDERED', 'Shopwork'),
    (r'SHOWROOM|GRAND PIANOS|UPRIGHT PIANOS|VESTIBULE|CONSIGNMENT|REBUILT', 'Showroom'),
    (r'BOXED|STORAGE|ATTIC|HOLDING', 'Storage'),
    (r'RENT|FINANCING', 'Rentals & Financing'),
    (r'DIGITAL|NEW$|USED$', 'Digital'),
    (r'LOFT|CONFERENCE|RECITAL|OFFICE|RESIDENCE', 'On Premises'),
]

def cell(row, idx):
    return row[idx].strip() if idx < len(row) else ''

def is_section_header(row):
    filled = [c for c in row if c.strip()]
    if not filled or len(filled) > 3:
        return None
    owner = cell(row, 1)
    if owner and len(owner) < 60 and owner == owner.upper() and not any(ch.isdigit() for ch in owner):
        return owner
    return None

def group_for(section):
    for pattern, group in GROUPS:
        if re.search(pattern, section):
            return group
    return 'Other'

def owner_name(owner):
    """First line of the owner cell that looks like a name (skip *notes* and status flags)."""
    for line in owner.split('\n'):
        line = line.strip()
        if not line or line.startswith('*') or line.startswith('http'):
            continue
        if re.match(r'^(PAID IN FULL|SOLD TO:|RUSH|ON HOLD|adding|Add )', line, re.I):
            continue
        if '@' in line or re.search(r'\d{3}', line):
            continue
        return line
    return ''

def main():
    with open(RAW) as f:
        vals = json.load(f)['values']

    pianos, sections = [], []
    section, seq = None, 0
    for i, row in enumerate(vals):
        if i < 6:
            continue  # blank row, header, legend rows
        header = is_section_header(row)
        if header:
            section = header
            sections.append({'name': section, 'group': group_for(section), 'row': i + 1})
            continue
        if not any(c.strip() for c in row):
            continue
        summary, serial, make = cell(row, 3), cell(row, 2), cell(row, 5)
        owner = cell(row, 1)
        if not (summary or serial or make):
            # note-only row: attach to previous piano's notes context, skip otherwise
            continue
        seq += 1
        p = {k: cell(row, idx) for k, idx in COLS.items()}
        p['id'] = seq
        p['sheet_row'] = i + 1
        p['section'] = section or 'Uncategorized'
        p['group'] = group_for(section) if section else 'Other'
        p['owner_name'] = owner_name(owner)
        pianos.append(p)

    out = {
        'generated_at': datetime.now().strftime('%b %d, %Y at %I:%M %p'),
        'source': 'Piano Log & Inventory — first tab (Piano Log)',
        'sections': sections,
        'pianos': pianos,
    }
    with open(OUT, 'w') as f:
        json.dump(out, f, ensure_ascii=False)
    print(f'{len(pianos)} pianos across {len(sections)} sections -> {OUT}')

if __name__ == '__main__':
    main()
