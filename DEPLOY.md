# Hosting the Piano Log app on Netlify

The hosted app works exactly like the local one — live data, password
protected — but runs on Netlify Functions instead of `server.py`, and reads
the sheet through a small Google Apps Script web app instead of `gog`
(this is the same pattern the BLP sales console uses).

```
Browser ──► Netlify (static app + functions, password cookie)
                 │ /api/pianos, /api/tabs, /api/tab   (5-min cache)
                 ▼
        Apps Script web app (runs as karmel@, shared-secret access)
                 ▼
        Piano Log & Inventory spreadsheet  ← source of truth
```

Two one-time setup steps:

## 1. Deploy the Apps Script bridge (~3 minutes)

1. Go to [script.google.com](https://script.google.com) signed in as
   **karmel@brighamlarsonpianos.com** → **New project**.
2. Paste the contents of `apps-script/Code.gs`, and replace
   `PASTE_SECRET_HERE` with the `SHEETS_SYNC_SECRET` value from
   `data/deploy-secrets.txt` (local file, not in this repo).
3. Name the project "Piano Log Bridge".
4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Authorize when prompted, and copy the **Web app URL**
   (`https://script.google.com/macros/s/…/exec`).

"Anyone" is safe here: every request without the shared secret gets
`{"error":"unauthorized"}` — the URL alone reveals nothing.

## 2. Create the Netlify site (~3 minutes)

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an
   existing project → GitHub → `karmel-spec/pianolog`** (build settings are
   read from `netlify.toml`; no build command needed).
2. Before (or after) the first deploy, add the environment variables under
   **Site configuration → Environment variables**:

   | Variable | Value |
   |---|---|
   | `APPS_SCRIPT_URL` | the Web app URL from step 1 |
   | `SHEETS_SYNC_SECRET` | from `data/deploy-secrets.txt` |
   | `PIANOLOG_PASSWORD` | the app password |

3. Trigger a deploy (Deploys → Trigger deploy) if you added the vars after
   the first build.

That's it — the site is live at `https://<sitename>.netlify.app`, asks for
the password, and serves live sheet data from anywhere.

## Notes

- **The local app keeps working** unchanged (`python3 server.py`, port 8412).
- Sessions are stateless signed cookies (30 days), so they survive function
  cold starts and redeploys.
- To change the password: update `PIANOLOG_PASSWORD` in Netlify env vars and
  redeploy (and `data/password.txt` locally).
- To rotate the sheet secret: generate a new one, update it in both the Apps
  Script (then create a **new deployment**) and the Netlify env var.
- The QuickBooks owner overlay (`data/owners-overlay.json`) is local-only for
  now; it does not ship to Netlify.
