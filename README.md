# Piano Log — Brigham Larson Pianos

Internal webapp presenting the full piano inventory history from the
[Piano Log & Inventory sheet](https://docs.google.com/spreadsheets/d/1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc/edit)
(first tab, "Piano Log"), styled to match brighamlarsonpianos.com.

## Run it

```sh
./scripts/refresh.sh   # first time: pull the data snapshot (data/ is gitignored)
python3 -m http.server 8412 --directory ~/PianoLogApp
# open http://localhost:8412
```

(Also registered as the `piano-log` server in `~/.claude/launch.json`.)

> **Note:** `data/` is not committed — the snapshots contain customer contact
> info and this repo is public. Each machine generates its own snapshot with
> `scripts/refresh.sh` (requires `gog` authed as karmel@brighamlarsonpianos.com).

## Refresh the data

The app reads a snapshot in `data/pianos.json`. To pull the latest from Google Sheets:

```sh
./scripts/refresh.sh
```

This uses `gog` with the karmel@brighamlarsonpianos.com account, then re-runs
`scripts/parse.py` (which turns the raw sheet rows into clean JSON — section
headers become `section`/`group` fields on each piano).

## Structure

- `index.html` — the whole app (vanilla HTML/CSS/JS, no build step)
- `data/pianolog-raw.json` — raw sheet values as fetched
- `data/pianos.json` — parsed data the app loads
- `assets/blp-logo.png` — site logo (from the Shopify CDN)
- `scripts/parse.py`, `scripts/refresh.sh`

## Branding

Matches brighamlarsonpianos.com (Shopify): Assistant font, brand red `#9E2020`
(hover `#B43333`), near-black `#121212`, cream `#F9F7EE`/`#EFE5D6`, and the
logo's red-line-with-center-dot divider motif.
