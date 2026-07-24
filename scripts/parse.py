#!/usr/bin/env python3
"""Parse raw Piano Log sheet values into clean JSON for the webapp.

Importable: parse(values) -> dict.
CLI: python3 scripts/parse.py  (reads data/pianolog-raw.json, writes data/pianos.json)
"""
import json, os, re
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
    'current_phase': 118,  # col DO ("CURRENT PHASE", e.g. "In Queue")
}

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

def meaningful(row):
    """Cells with real content (not lone punctuation)."""
    return [c for c in row if c.strip() and c.strip() not in {'.', '`', 'x', '-'}]

def section_header(row):
    filled = meaningful(row)
    if not filled or len(filled) > 3:
        return None
    owner = cell(row, 1)
    if owner and len(owner) < 60 and owner == owner.upper() and not any(ch.isdigit() for ch in owner):
        return owner
    return None

ARTIFACT_DATE = re.compile(r'^\s*(12/31/1899|1/[12]/1900)\s*$')

def data_cells(row):
    """Cells that carry real record data: everything except the owner (1),
    location (20), and PUBLISHED checkbox (8) columns, lone x/./- marks, and
    epoch-artifact dates left behind by the sheet."""
    out = []
    for i, c in enumerate(row):
        c = c.strip()
        if not c or i in (1, 8, 20) or c in {'.', '`', 'x', '-', 'TRUE', 'FALSE'}:
            continue
        if ARTIFACT_DATE.match(c):
            continue
        out.append(c)
    return out

def subsection_label(row):
    """Label rows that subdivide a section ("Ralph Nielsen's Player Shop",
    "Wing Room 2", "2026", "blue"): no record data, and the owner text isn't
    a person/contact ("Denham, Tiffany - Y", emails, phone numbers)."""
    owner = cell(row, 1)
    if data_cells(row):
        return None
    if not owner:
        return None
    if re.match(r'^[A-Z][a-z]+, [A-Z]', owner):  # "Last, First" -> real entry
        return None
    if '@' in owner or re.search(r'\d{3}[-.\s)]\d', owner):  # contact info -> entry
        return None
    return ' '.join(owner.split('\n'))[:80]

def group_for(section):
    for pattern, group in GROUPS:
        if re.search(pattern, section or ''):
            return group
    return 'Other'

def owner_name(owner):
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

CLASSIFY_COLS = 53  # A..BA — row classification ignores the far auxiliary
                    # columns (Shopify sync, inventory checkboxes, phase), which
                    # carry residual content even on section/label rows.

def parse(vals):
    pianos, sections = [], []
    section, subsection, seq = None, None, 0
    for i, row in enumerate(vals):
        if i < 6:
            continue  # blank row, header, legend rows
        crow = row[:CLASSIFY_COLS]
        header = section_header(crow)
        if header:
            section, subsection = header, None
            sections.append({'name': section, 'group': group_for(section), 'row': i + 1})
            continue
        if not meaningful(crow):
            continue
        label = subsection_label(crow)
        if label:
            subsection = label
            continue
        dc = data_cells(crow)
        if not cell(row, 1) and (not dc or dc == [cell(row, 18)]):
            continue  # checkbox/status-only artifact rows with no substance
        seq += 1
        p = {k: cell(row, idx) for k, idx in COLS.items()}
        p['id'] = seq
        p['sheet_row'] = i + 1
        p['section'] = section or 'Uncategorized'
        p['subsection'] = subsection or ''
        p['group'] = group_for(section)
        p['owner_name'] = owner_name(p['owner'])
        if not (p['summary'] or p['serial'] or p['make']):
            p['summary'] = p['owner_name'] or p['owner'].split('\n')[0][:60] or '(unidentified entry)'
            p['unidentified'] = True
        pianos.append(p)
    # Queue position: for shopwork sections the row order IS the work queue
    # (top row = #1, next up for delivery). Position among the section's
    # pianos, in sheet-row order.
    by_section = {}
    for p in pianos:
        if p['group'] == 'Shopwork':
            by_section.setdefault(p['section'], []).append(p)
    for members in by_section.values():
        for pos, p in enumerate(members, 1):
            p['queue_pos'] = pos
            p['queue_total'] = len(members)
    return {
        'generated_at': datetime.now().strftime('%b %d, %Y at %I:%M %p'),
        'source': 'Piano Log & Inventory — first tab (Piano Log)',
        'sections': sections,
        'pianos': pianos,
    }

def main():
    with open(os.path.join(ROOT, 'data', 'pianolog-raw.json')) as f:
        vals = json.load(f)['values']
    out = parse(vals)
    with open(os.path.join(ROOT, 'data', 'pianos.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"{len(out['pianos'])} pianos across {len(out['sections'])} sections")

if __name__ == '__main__':
    main()
