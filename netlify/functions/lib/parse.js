// Piano Log app parser — since 10/7 a thin wrapper over the ONE shared
// parser (pianolog-parse.cjs, canonical copy in salesapp2/netlify/functions/
// lib; scripts/sync-parser.sh there keeps this copy identical). The mirror
// sync runs the same code, so what the bridge fallback parses here is what
// Supabase holds. scripts/parse.py is the local-server fallback of the same
// rules — keep it in sync.
const shared = require('./pianolog-parse.cjs');

function parse(vals) {
  const { sections, pianos } = shared.parsePianoLogApp(vals || []);
  return {
    generated_at: shared.plGeneratedAt(),
    source: 'Piano Log & Inventory — first tab (Piano Log)',
    sections, pianos,
  };
}

module.exports = { parse };
