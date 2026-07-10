# Piano Log — Brigham Larson Pianos

Internal webapp presenting the full piano inventory history from the
[Piano Log & Inventory sheet](https://docs.google.com/spreadsheets/d/1ZunbPKygpQlcXfTyPowDHdUE9spJ3uV1XA4iX1eoKRc/edit)
(first tab, "Piano Log"), styled to match brighamlarsonpianos.com.

## Run it

```sh
python3 server.py
# open http://localhost:8412
```

(Also registered as the `piano-log` server in `~/.claude/launch.json`.)

The app is **live**: `server.py` reads the Google Sheet through the `gog` CLI
on demand (cached 5 minutes; the header's Refresh button forces a re-read), so
the spreadsheet stays the source of truth. Requires `gog` authenticated as
karmel@brighamlarsonpianos.com. If Google is unreachable it falls back to the
last snapshot in `data/` and shows an "Offline snapshot" indicator.

**Every visible spreadsheet tab is a navigation tab** in the app. "Piano Log"
gets the rich inventory view (tiles, charts, filters); the other tabs
(Restoration Contracts, Sell/Consign/Donate, Moving Web Leads, Appraisal
Requests, Piano Storage, PIE Program, Before/After galleries, Products,
Team Bios, Shopify, Image Uploads) get a generic live explorer: the 8
most-populated columns as a sortable, searchable table, with the full record
in a detail drawer. New tabs added to the sheet appear automatically
(the tab list refreshes hourly).

> **Note:** `data/` is not committed — the snapshots contain customer contact
> info and this repo is public. The server regenerates them on first fetch.

## Password

The app is password-protected (branded sign-in page; session cookie, valid
until the server restarts). The password is **not** in this repo — it lives in
`data/password.txt` (gitignored) or the `PIANOLOG_PASSWORD` env var. If
neither exists, the app runs open with no password.

## Structure

- `server.py` — live server: static files + `/api/pianos` (gog fetch + parse, 5-min cache, `?force=1` to bypass)
- `index.html` — the whole frontend (vanilla HTML/CSS/JS, no build step)
- `scripts/parse.py` — sheet-rows → clean JSON (section headers → `section`/`group`, sub-labels → `subsection`)
- `scripts/refresh.sh` — manual snapshot refresh (optional; the server does this automatically)
- `data/` (gitignored) — raw + parsed snapshots, used as offline fallback
- `assets/blp-logo.png` — site logo (from the Shopify CDN)

## Branding

Matches brighamlarsonpianos.com (Shopify): Assistant font, brand red `#9E2020`
(hover `#B43333`), near-black `#121212`, cream `#F9F7EE`/`#EFE5D6`, and the
logo's red-line-with-center-dot divider motif.
