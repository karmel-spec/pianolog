#!/bin/zsh
# Refresh Piano Log data from Google Sheets and re-parse.
set -e
cd "$(dirname "$0")/.."
gog -a karmel@brighamlarsonpianos.com --json sheets get \
  1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc "'Piano Log'!A1:BA5000" \
  > data/pianolog-raw.json
python3 scripts/parse.py
echo "Done. Reload the app to see fresh data."
