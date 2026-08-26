// JS port of scripts/parse.py — keep the two in sync.
// Parses raw Piano Log sheet values into the app's JSON shape.

const COLS = {
  updated_at: 0, owner: 1, serial: 2, summary: 3, year: 4,
  make: 5, model: 6, size: 7, published: 8, category: 9,
  finish: 10, sheen: 11, trim: 12,
  before_photos_hold: 13,  // "Before Photos Not Published Until After Sale" flag
  before_photos: 14, before_video: 15, after_photos: 16, after_video: 17,
  status: 18, bench: 19, location_status: 20, entry_exit_dates: 21,
  receiving_exiting: 22, project_category: 23, cogs_invoice: 24,
  agreements_price: 25, notes: 26, completion_date: 27,
  isolved_job: 28, qbo: 29, tags: 30,
  down_payment_date: 32, milestones: 35,
  warranty: 64,  // col BM ("WARRANTY", e.g. "3 Year BLP")
  new_piano_warranty_registered: 87,  // col CJ (Hailun/Hallet Davis new-piano warranty)
  qrs_warranty_registered: 88,        // col CK
  warranty_sent_to_customer: 89,      // col CL
  current_phase: 118,  // col DO ("CURRENT PHASE", e.g. "In Queue")
  track: 123,  // col DT ("TRACK", e.g. "Rebuild, Refinish")
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

const HEADER_PAREN_RE = /\([^)]*\)/g;

function sectionHeader(row) {
  const filled = meaningful(row);
  if (!filled.length || filled.length > 3) return null;
  const owner = cell(row, 1);
  if (!owner) return null;
  // The ALL-CAPS check ignores parenthetical asides and line breaks —
  // e.g. "SOLD OR COMPLETED (but not gone yet)\nREADY FOR PHOTOS/VIDEOS"
  // is still a section header despite the lowercase note in parens.
  const flat = owner.split('\n').join(' ');
  const core = flat.replace(HEADER_PAREN_RE, '').replace(/\s+/g, ' ').trim();
  if (core && core.length < 60 && core === core.toUpperCase() && !/\d/.test(core)) {
    return flat.replace(/\s+/g, ' ').trim();
  }
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

const CLASSIFY_COLS = 53;  // A..BA — row classification ignores the far auxiliary
                           // columns (Shopify sync, inventory checkboxes, phase),
                           // which carry residual content even on section/label rows.

function parse(vals) {
  const pianos = [], sections = [];
  let section = null, subsection = null, seq = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < 6) continue;  // blank row, header, legend rows
    const row = vals[i].map(String);
    const crow = row.slice(0, CLASSIFY_COLS);
    const header = sectionHeader(crow);
    if (header) {
      section = header; subsection = null;
      sections.push({ name: section, group: groupFor(section), row: i + 1 });
      continue;
    }
    if (!meaningful(crow).length) continue;
    const label = subsectionLabel(crow);
    if (label) { subsection = label; continue; }
    const dc = dataCells(crow);
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
  // Queue position: for shopwork sections the row order IS the work queue
  // (top row = #1, next up for delivery). Position among the section's
  // pianos, in sheet-row order.
  const bySection = {};
  for (const p of pianos) {
    if (p.group === 'Shopwork') (bySection[p.section] = bySection[p.section] || []).push(p);
  }
  for (const members of Object.values(bySection)) {
    members.forEach((p, i) => { p.queue_pos = i + 1; p.queue_total = members.length; });
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
