/**
 * Piano Log — ONE shared parser (read mirror, phase 1, 2026-10-07).
 *
 * Input: the sheet's "Piano Log" tab as a values matrix (rows of strings,
 * row 1 = index 0; the header is row 2 = index 1), exactly as the Sheets API
 * (FORMATTED_VALUE), the public CSV export and the Apps Script bridge
 * (getDisplayValues) all deliver it — the three were diffed cell-for-cell
 * on 2026-10-07 and are identical.
 *
 * Output: BOTH apps' records from the same pass —
 *   sm: the Store Map record per piano  (port of BLPStoreMap data.mjs parsePianos)
 *   pl: the Piano Log app record + sections (port of PianoLogApp lib/parse.js)
 * plus mirror rows for Supabase (pianolog.pianos) that carry both.
 *
 * CANONICAL COPY: ~/salesapp2/netlify/functions/lib/pianolog-parse.cjs.
 * BLPStoreMap/netlify/functions/lib/ and PianoLogApp/netlify/functions/lib/
 * hold byte-identical copies for their fallback paths (scripts/sync-parser.sh
 * in salesapp2 copies them). Zero dependencies, CommonJS so .mjs/.mts (default
 * import) and .js (require) can all load it.
 */
'use strict';

const TZ = 'America/Denver';
const denverDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });

/* ---------- CSV (fallback paths only) ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ================= Store Map record (data.mjs parsePianos) ================= */
const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
function parseDates(s) {
  const out = [];
  for (const m of (s || '').matchAll(DATE_RE)) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = new Date(Date.UTC(y, +m[1] - 1, +m[2]));
    if (!isNaN(d)) out.push(d);
  }
  return out;
}

function pianoType(cat, name) {
  const c = (cat || '').toLowerCase();
  if (c.startsWith('grand') || c.includes(', grand')) return 'grand';
  if (c.includes('digital')) return 'digital';
  if (/(upright|console|spinet|studio)/.test(c)) return 'upright';
  const n = (name || '').toLowerCase();
  if (/(upright|console|spinet|studio|vertical)/.test(n)) return 'upright';
  if (/grand/.test(n)) return 'grand';
  return 'other';
}

function driveUrl(v) {
  const m = /(https:\/\/(?:drive|docs)\.google\.com\/[^\s,"']+)/.exec(v || '');
  return m ? m[1] : '';
}

const SLOT_RE = /^\d+(?:\.\d)?[a-zA-Z]?$/;

const SM_HEADERS = {
  phaseIdx: 'CURRENT PHASE', trackIdx: 'TRACK', doneIdx: 'PHASES DONE', waitIdx: 'WAITING NOTE',
  crIdx: 'CLIENT REPORTS', cbIdx: 'CHECK BACK', cabIdx: 'CABINETRY', typeOvIdx: 'TYPE OVERRIDE',
  plateIdx: 'PLATE STATUS', colorPickIdx: 'COLOR FIRST PICK', colorFinalIdx: 'COLOR FINAL APPROVED',
  phaseNotesIdx: 'PHASE NOTES', payPlanIdx: 'PAYMENT PLAN', payMsIdx: 'PAY MILESTONE',
  adminStIdx: 'ADMIN STEPS', keySvcIdx: 'KEY SERVICE', benchLocIdx: 'BENCH LOCATION',
  plateHwIdx: 'PLATE HW LOCATION', plateTempIdx: 'PLATE TEMP SPOT', plateHwStatusIdx: 'PLATE HARDWARE STATUS',
  plateFinishIdx: 'PLATE HARDWARE FINISH', keytopMatIdx: 'KEYTOP MATERIAL', crmIdIdx: 'CRM CLIENT ID',
  scopeNotesIdx: 'SCOPE NOTES', keytopIdx: 'KEYTOP STATUS', impNoteIdx: 'IMPORTANT NOTES',
  pianoNotesIdx: 'PIANO NOTES', benchNoteIdx: 'BENCH NOTE', tempEntryIdx: 'TEMP ENTRY',
  tagSnapIdx: 'TAG SNAPSHOT', pvideoIdx: 'PROGRESS VIDEO', paperworkIdx: 'PAPERWORK',
};

/** Header-name → 0-based column index map for the Store Map fields. */
function smColumns(hdrRow) {
  const hdr = hdrRow || [];
  const find = name => hdr.findIndex(h => String(h || '').trim().toUpperCase() === name);
  const idx = {};
  for (const [k, name] of Object.entries(SM_HEADERS)) idx[k] = find(name);
  const pi = find('TAG / INVOICE PRICE');
  idx.priceIdx = pi >= 0 ? pi : find('PRICE');
  return idx;
}

/**
 * Store Map records from the values matrix. Same rules, same output as the
 * data.mjs parsePianos it replaces — only the input changed from CSV text.
 */
function parseStoreMap(rows, today) {
  const pianos = [];
  const hdr = rows[1] || [];
  const I = smColumns(hdr);
  const { phaseIdx, priceIdx, trackIdx, doneIdx, waitIdx, crIdx, cbIdx, cabIdx, typeOvIdx, plateIdx,
    colorPickIdx, colorFinalIdx, phaseNotesIdx, payPlanIdx, payMsIdx, adminStIdx, keySvcIdx, benchLocIdx,
    plateHwIdx, plateTempIdx, plateHwStatusIdx, plateFinishIdx, keytopMatIdx, crmIdIdx, scopeNotesIdx,
    keytopIdx, impNoteIdx, pianoNotesIdx, benchNoteIdx, tempEntryIdx, tagSnapIdx, pvideoIdx, paperworkIdx } = I;
  // CUSTOM SHOPWORK queue bounds (1-based rows)
  let qHdr = 0, qEnd = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k] || [];
    const b = (r[1] || '').trim(), c = (r[2] || '').trim(), d = (r[3] || '').trim();
    if (!qHdr) { if (b.toUpperCase() === 'CUSTOM SHOPWORK' && !c && !d) qHdr = k + 1; }
    else if (!qEnd && !b && !c && !d) qEnd = k + 1;
  }
  const todayUTC = new Date((today || denverDay()) + 'T00:00:00Z');
  let section = '', soldZone = false;
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i] || [];
    const col = j => String(r[j] == null ? '' : r[j]).trim();
    const serial = col(2), summary = col(3);
    const head = col(1);
    const capsBanner = !col(4) && !col(5) && !col(6) && head && !head.includes('\n')
      && head.length < 60 && /[A-Z]/.test(head) && !/[a-z]/.test(head);
    if (!serial && (!summary || capsBanner)) {
      if (head) {
        section = head;
        if (head.trim().toUpperCase() === 'SOLD') soldZone = true;
      }
      continue;
    }
    const phaseRaw = phaseIdx >= 0 ? col(phaseIdx) : '';
    const archived = soldZone || /delivered/i.test(phaseRaw);
    if (['SHOPIFY', 'ADMIN', 'WEB'].includes(summary.toUpperCase())
        || ['ADMIN', 'LOCATION / STATUS'].includes(col(20).toUpperCase())
        || col(21).includes('Arrival Date')) continue;
    const status = col(18), ol = col(1).toLowerCase();
    let loc = col(20);
    if (/^currently rented/i.test(section) && !/rent/i.test(loc)) loc = 'Rented' + (loc ? ' — was at ' + loc : '');
    if (/\bstand\b/i.test(summary) || serial.trim().toLowerCase() === 'stand') continue;
    if (!col(4) && !col(5)
        && (/^haydn room$/i.test(summary.trim()) || /go to .* section/i.test(summary + ' ' + serial)
            || /^piano is /i.test(summary.trim()))) continue;
    const med = j => {
      const v = col(j);
      if (!v) return false;
      if (/^x$/i.test(v.trim())) return 'na';
      return /^skip/i.test(v) ? 'skip' : true;
    };
    const dates = parseDates(col(21)).filter(d => d <= todayUTC);
    const entered = dates.length ? new Date(Math.max(...dates)) : null;
    const isNew = !!entered && (todayUTC - entered) / 86400000 <= 7;
    const active = !archived && !ol.includes('never received')
      && !status.toLowerCase().includes('never received')
      && !ol.includes('duplicate');
    pianos.push({
      row: i + 1, section, owner: col(1), serial, archived,
      summary: summary || [col(4), col(5), col(6)].filter(Boolean).join(' '),
      year: col(4), make: col(5), model: col(6), size: col(7),
      type: (typeOvIdx >= 0 && col(typeOvIdx)) || pianoType(col(9), summary + ' ' + col(6)),
      typeOverride: (typeOvIdx >= 0 && col(typeOvIdx)) || '', status, location: loc,
      bench: col(19).slice(0, 60), plan: col(23).slice(0, 220),
      benchLoc: benchLocIdx >= 0 ? col(benchLocIdx).slice(0, 80) : '',
      plateHw: plateHwIdx >= 0 ? col(plateHwIdx).slice(0, 80) : '',
      plateTemp: plateTempIdx >= 0 ? col(plateTempIdx).slice(0, 90) : '',
      plateHwStatus: plateHwStatusIdx >= 0 ? col(plateHwStatusIdx).slice(0, 40) : '',
      plateFinish: plateFinishIdx >= 0 ? col(plateFinishIdx).slice(0, 30) : '',
      keytopMaterial: keytopMatIdx >= 0 ? col(keytopMatIdx).slice(0, 30) : '',
      scopeNotes: scopeNotesIdx >= 0 ? col(scopeNotesIdx).slice(0, 500) : '',
      crmClientId: crmIdIdx >= 0 ? col(crmIdIdx).trim() : '',
      keytopStatus: keytopIdx >= 0 ? col(keytopIdx).slice(0, 40) : '',
      importantNote: impNoteIdx >= 0 ? col(impNoteIdx).slice(0, 200) : '',
      pianoNotes: pianoNotesIdx >= 0 ? col(pianoNotesIdx).slice(0, 2000) : '',
      benchNote: benchNoteIdx >= 0 ? col(benchNoteIdx).slice(0, 160) : '',
      tempEntry: tempEntryIdx >= 0 ? col(tempEntryIdx).slice(0, 80) : '',
      planNotes: col(26).slice(0, 300), replate: col(50).slice(0, 20),
      payPlan: payPlanIdx >= 0 ? col(payPlanIdx) : '',
      payMilestone: payMsIdx >= 0 ? col(payMsIdx) : '',
      adminSteps: adminStIdx >= 0 ? col(adminStIdx) : '',
      keyService: keySvcIdx >= 0 ? col(keySvcIdx) : '',
      keywork: col(51).slice(0, 90),
      tagSnapshot: tagSnapIdx >= 0 ? col(tagSnapIdx) : '',
      paperwork: paperworkIdx >= 0 ? col(paperworkIdx) : '',
      tasks: {
        bass: col(38).slice(0, 80), decals: col(39).slice(0, 80), parts: col(40).slice(0, 80),
        pedals: col(41).slice(0, 80), pedaltrim: col(42).slice(0, 80), lock: col(43).slice(0, 80),
        strikeplate: col(44).slice(0, 80), escutcheon: col(45).slice(0, 80), decor: col(46).slice(0, 80),
        hinges: col(47).slice(0, 80), screws: col(48).slice(0, 80), otherhw: col(49).slice(0, 80),
      },
      logExtras: (() => {
        const used = new Set([0, 1, 2, 3, 4, 5, 6, 7, 9, 14, 15, 16, 17, 18, 19, 20, 21, 23, 26, 50, 51, 68,
          phaseIdx, priceIdx, trackIdx, doneIdx, waitIdx, crIdx, cbIdx, cabIdx, typeOvIdx,
          payPlanIdx, payMsIdx, adminStIdx, keySvcIdx, tagSnapIdx, paperworkIdx]);
        const out = {};
        for (let c = 0; c < hdr.length; c++) {
          const h = String(hdr[c] || '').trim();
          if (!h || used.has(c)) continue;
          const v = col(c);
          if (v) out[h] = v.slice(0, 300);
        }
        return out;
      })(),
      bphotoUrl: driveUrl(col(14)), bvideoUrl: driveUrl(col(15)),
      aphotoUrl: driveUrl(col(16)), avideoUrl: driveUrl(col(17)),
      pvideoUrl: pvideoIdx >= 0 ? driveUrl(col(pvideoIdx)) : '',
      mainFolder: driveUrl(col(68)),
      isSlot: SLOT_RE.test(loc),
      entered: entered ? entered.toISOString().slice(0, 10) : null,
      phase: phaseIdx >= 0 ? col(phaseIdx) : '',
      price: priceIdx >= 0 && /\d/.test(col(priceIdx)) ? col(priceIdx) : '',
      track: trackIdx >= 0 ? col(trackIdx) : '',
      phasesDone: doneIdx >= 0 ? col(doneIdx) : '',
      waitNote: waitIdx >= 0 ? col(waitIdx) : '',
      clientReports: crIdx >= 0 ? col(crIdx) : '',
      checkBack: cbIdx >= 0 ? col(cbIdx) : '',
      cabinetry: cabIdx >= 0 ? col(cabIdx) : '',
      plateStatus: plateIdx >= 0 ? col(plateIdx) : '',
      colorPick: colorPickIdx >= 0 ? col(colorPickIdx) : '',
      colorFinal: colorFinalIdx >= 0 ? col(colorFinalIdx) : '',
      phaseNotes: phaseNotesIdx >= 0 ? col(phaseNotesIdx).slice(0, 600) : '',
      bphoto: med(14), bvideo: med(15), aphoto: med(16), avideo: med(17),
      queuePos: 0, queueTotal: 0,
      isNew, active,
    });
  }
  const q = pianos.filter(p => qHdr && qEnd && p.row > qHdr && p.row < qEnd);
  q.forEach((p, k) => { p.queuePos = k + 1; p.queueTotal = q.length; });
  return { pianos, queue: { hdr: qHdr, end: qEnd }, columns: I };
}

/* ================= Piano Log app record (lib/parse.js) ================= */
const PL_COLS = {
  updated_at: 0, owner: 1, serial: 2, summary: 3, year: 4,
  make: 5, model: 6, size: 7, published: 8, category: 9,
  finish: 10, sheen: 11, trim: 12,
  before_photos_hold: 13,
  before_photos: 14, before_video: 15, after_photos: 16, after_video: 17,
  status: 18, bench: 19, location_status: 20, entry_exit_dates: 21,
  receiving_exiting: 22, project_category: 23, cogs_invoice: 24,
  agreements_price: 25, notes: 26, completion_date: 27,
  isolved_job: 28, qbo: 29, tags: 30,
  down_payment_date: 32, milestones: 35,
  warranty: 64,
  new_piano_warranty_registered: 87,
  qrs_warranty_registered: 88,
  warranty_sent_to_customer: 89,
  current_phase: 118,
  track: 123,
};

const PL_GROUPS = [
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
  if (/^[A-Z][a-z]+, [A-Z]/.test(owner)) return null;
  if (owner.includes('@') || /\d{3}[-.\s)]\d/.test(owner)) return null;
  return owner.split('\n').join(' ').slice(0, 80);
}
function groupFor(section) {
  for (const [re, g] of PL_GROUPS) if (re.test(section || '')) return g;
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
const CLASSIFY_COLS = 53;

function plGeneratedAt(d = new Date()) {
  return d.toLocaleString('en-US', {
    timeZone: TZ, month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** Piano Log app records + sections. Same rules and output as lib/parse.js. */
function parsePianoLogApp(vals) {
  const pianos = [], sections = [];
  let section = null, subsection = null, seq = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < 6) continue;
    const row = (vals[i] || []).map(v => String(v == null ? '' : v));
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
    for (const [k, idx] of Object.entries(PL_COLS)) p[k] = cell(row, idx);
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
  const bySection = {};
  for (const p of pianos) {
    if (p.group === 'Shopwork') (bySection[p.section] = bySection[p.section] || []).push(p);
  }
  for (const members of Object.values(bySection)) {
    members.forEach((p, i) => { p.queue_pos = i + 1; p.queue_total = members.length; });
  }
  return { sections, pianos };
}

/* ================= mirror rows (Supabase pianolog.pianos) ================= */
function colLetter(i) {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Header-keyed names for every column: "CURRENT PHASE", blank → "_DQ", dupes → "NAME#DQ". */
function rawKeys(hdrRow) {
  const hdr = hdrRow || [];
  const seen = new Map(), keys = [];
  const width = Math.max(hdr.length, 150);
  for (let c = 0; c < width; c++) {
    const h = String(hdr[c] || '').trim();
    let k = h || '_' + colLetter(c);
    if (seen.has(k)) k = k + '#' + colLetter(c);
    seen.set(k, c);
    keys.push(k);
  }
  return keys;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function rowHash(parts) {
  const s = JSON.stringify(parts);
  // two passes over different seeds → 16 hex chars, plenty for change detection
  return fnv1a(s) + fnv1a(s.length + '|' + s.split('').reverse().join(''));
}

const normSerial = s => String(s || '').trim().replace(/\s+/g, ' ');

/**
 * Everything the mirror needs from one pass over the values matrix:
 *   { header, keys, sm, pl, rows, sections, queue }
 * rows = pianolog.pianos records (one per sheet row that either app treats
 * as a piano), keyed by serial (first occurrence above later duplicates),
 * "serial#r<row>" for a duplicate serial, "~r<row>" for a row without one.
 */
function parseAll(values, opts = {}) {
  const rows = values || [];
  const header = rows[1] || [];
  const keys = rawKeys(header);
  const sm = parseStoreMap(rows, opts.today);
  const pl = parsePianoLogApp(rows);
  const byRow = new Map();
  for (const p of sm.pianos) byRow.set(p.row, { sm: p, pl: null });
  for (const p of pl.pianos) {
    const e = byRow.get(p.sheet_row);
    if (e) e.pl = p; else byRow.set(p.sheet_row, { sm: null, pl: p });
  }
  const out = [];
  const serialSeen = new Set();
  const rowIdx = [...byRow.keys()].sort((a, b) => a - b);
  for (const ri of rowIdx) {
    const { sm: s, pl: p } = byRow.get(ri);
    const r = rows[ri - 1] || [];
    const raw = {};
    for (let c = 0; c < r.length; c++) {
      const v = String(r[c] == null ? '' : r[c]);
      if (v !== '') raw[keys[c] || ('_' + colLetter(c))] = v;
    }
    const serial = normSerial(s ? s.serial : p.serial);
    let key;
    if (!serial) key = '~r' + ri;
    else if (serialSeen.has(serial.toLowerCase())) key = serial + '#r' + ri;
    else { key = serial; serialSeen.add(serial.toLowerCase()); }
    const col = j => String(r[j] == null ? '' : r[j]).trim();
    const sec = s ? s.section : p.section;
    const active = s ? s.active : p.group !== 'Sold / Exited' && p.group !== 'Web Archive';
    const archived = s ? s.archived : !active;
    const rec = {
      key, serial, row_index: ri,
      section: sec || '', subsection: p ? p.subsection || '' : '',
      queue_pos: s && s.queuePos ? s.queuePos : (p && p.queue_pos) || 0,
      queue_total: s && s.queueTotal ? s.queueTotal : (p && p.queue_total) || 0,
      active, archived,
      summary: s ? s.summary : p.summary,
      phase: s ? s.phase : p.current_phase,
      location: col(20),
      status: col(18), track: s ? s.track : p.track,
      make: col(5), model: col(6), year: col(4),
      owner: col(1), price: s ? s.price : '',
      sm: s, pl: p, raw,
    };
    rec.hash = rowHash([rec.key, rec.row_index, rec.section, rec.subsection, rec.queue_pos, rec.queue_total,
      rec.active, rec.archived, s, p, raw]);
    out.push(rec);
  }
  return { header, keys, sm: sm.pianos, pl: pl.pianos, sections: pl.sections, queue: sm.queue, rows: out };
}

module.exports = {
  parseAll, parseStoreMap, parsePianoLogApp, parseCSV, rawKeys, colLetter,
  plGeneratedAt, pianoType, SLOT_RE, PL_COLS, SM_HEADERS, smColumns, normSerial, TZ,
};
