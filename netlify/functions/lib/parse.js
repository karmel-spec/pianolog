// JS port of scripts/parse.py — keep the two in sync.
// Parses raw Piano Log sheet values into the app's JSON shape.

const COLS = {
  updated_at: 0, owner: 1, serial: 2, summary: 3, year: 4,
  make: 5, model: 6, size: 7, published: 8, category: 9,
  finish: 10, sheen: 11, trim: 12, before_photos: 13,
  after_photos: 15, before_video: 16, after_video: 17,
  status: 18, bench: 19, location_status: 20, entry_exit_dates: 21,
  receiving_exiting: 22, project_category: 23, cogs_invoice: 24,
  agreements_price: 25, notes: 26, completion_date: 27,
  isolved_job: 28, qbo: 29, tags: 30,
  down_payment_date: 32, milestones: 35,
};

const GROUPS = [
  [/CUSTOM SHOPWORK EXITED|SOLD|EXITED/, 'Sold / Exited'],
  [/^\(WEB\)/, 'Web Archive'],
  [/SHOPWORK|NEW \/ QUESTIONS|ORDERED/, 'Shopwork'],
  [/SHOWROOM|GRAND PIANOS|UPRIGHT PIANOS|VESTIBULE|CONSIGNMENT|REBUILT/, 'Showroom'],
  [/BOXED|STORAGE|ATTIC|HOLDING/, 'Storage'],
  [/RENT|FINANCING/, 'Rentals & Financing'],
  [/DIGITAL|NEW$|USED$/, 'Digital'],
  [/LOFT|CONFERENCE|RECITAL|OFFICE|RESIDENCE/, 'On Premises'],
];

const TRIVIAL = new Set(['.', '`', 'x', '-']);
const ARTIFACT_DATE = /^\s*(12\/31\/1899|1\/[12]\/1900)\s*$/;

const cell = (row, i) => (i < row.length ? String(row[i]).trim() : '');

function meaningful(row) {
  return row.filter(c => { const s = String(c).trim(); return s && !TRIVIAL.has(s); });
}

function sectionHeader(row) {
  const filled = meaningful(row);
  if (!filled.length || filled.length > 3) return null;
  const owner = cell(row, 1);
  if (owner && owner.length < 60 && owner === owner.toUpperCase() && !/\d/.test(owner)) return owner;
  return null;
}

function dataCells(row) {
  const out = [];
  row.forEach((c, i) => {
    const s = String(c).trim();
    if (!s || i === 1 || i === 8 || i === 20) return;
    if (TRIVIAL.has(s) || s === 'TRUE' || s === 'FALSE') return;
    if (ARTIFACT_DATE.test(s)) return;
    out.push(s);
  });
  return out;
}

function subsectionLabel(row) {
  const owner = cell(row, 1);
  if (dataCells(row).length) return null;
  if (!owner) return null;
  if (/^[A-Z][a-z]+, [A-Z]/.test(owner)) return null;          // "Last, First" -> entry
  if (owner.includes('@') || /\d{3}[-.\s)]\d/.test(owner)) return null;  // contact -> entry
  return owner.split('\n').join(' ').slice(0, 80);
}

function groupFor(section) {
  for (const [re, g] of GROUPS) if (re.test(section || '')) return g;
  return 'Other';
}

function ownerName(owner) {
  for (let line of owner.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('*') || line.startsWith('http')) continue;
    if (/^(PAID IN FULL|SOLD TO:|RUSH|ON HOLD|adding|Add )/i.test(line)) continue;
    if (line.includes('@') || /\d{3}/.test(line)) continue;
    return line;
  }
  return '';
}

function parse(vals) {
  const pianos = [], sections = [];
  let section = null, subsection = null, seq = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < 6) continue;  // blank row, header, legend rows
    const row = vals[i].map(String);
    const header = sectionHeader(row);
    if (header) {
      section = header; subsection = null;
      sections.push({ name: section, group: groupFor(section), row: i + 1 });
      continue;
    }
    if (!meaningful(row).length) continue;
    const label = subsectionLabel(row);
    if (label) { subsection = label; continue; }
    const dc = dataCells(row);
    if (!cell(row, 1) && (!dc.length || (dc.length === 1 && dc[0] === cell(row, 18)))) continue;
    seq += 1;
    const p = {};
    for (const [k, idx] of Object.entries(COLS)) p[k] = cell(row, idx);
    p.id = seq;
    p.sheet_row = i + 1;
    p.section = section || 'Uncategorized';
    p.subsection = subsection || '';
    p.group = groupFor(section);
    p.owner_name = ownerName(p.owner);
    if (!(p.summary || p.serial || p.make)) {
      p.summary = p.owner_name || p.owner.split('\n')[0].slice(0, 60) || '(unidentified entry)';
      p.unidentified = true;
    }
    pianos.push(p);
  }
  return {
    generated_at: new Date().toLocaleString('en-US', {
      timeZone: 'America/Denver', month: 'short', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).replace(',', ',').replace(' at ', ' at '),
    source: 'Piano Log & Inventory — first tab (Piano Log)',
    sections, pianos,
  };
}

module.exports = { parse };
