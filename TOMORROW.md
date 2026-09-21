# Getting it live for tomorrow

You have the stack running. Three things left, about 30 minutes.

## 1. Redeploy (new migrations + the wired-up app)

Push the latest files, then in Portainer: **Pull and redeploy**.

Check the PocketBase log:

```
[indexes] users: ok
[indexes] project_members: ok
[fields] points.added_in_field: added
Server started at http://0.0.0.0:8090
```

Then `curl http://localhost:8080/api/health` should return 200, not 502.

## 2. Create the accounts

Dashboard at `/_/` → Collections → `users` → New record, one each:

| email | name | initials | role |
|---|---|---|---|
| dylan@… | Dylan G | `DG` | lead |
| jacob@… | Jacob H | `JH` | tech |
| eric@… | Eric W | `EW` | tech |

Initials must match what is already on the sheet — `DG` and `JH` appear on
138 signed points and the app matches on them.

Give each a temporary password; they change it on first sign-in.

## 3. Load KOKUSAI

On any machine with Python and network access to the server:

```bash
pip install openpyxl requests

python3 seed_project.py \
  --url     https://checkout.yourdomain.com \
  --admin   you@company.com \
  --file    KOKUSAI_P2P_current.xlsm \
  --name    KOKUSAI \
  --job     86259065 \
  --location "Hillsboro, OR" \
  --members dylan@… jacob@… eric@…
```

It reads the workbook, creates the project, adds the members and writes all
456 points — carrying the existing sign-offs across, so the app opens at 46%
rather than empty. Re-running it updates rather than duplicates.

It prints the project id at the end. Use it for the export template:

```bash
curl -X POST https://checkout.yourdomain.com/export/template/<project_id> \
  -H "Authorization: <a lead's token>" \
  -F file=@KOKUSAI_P2P_current.xlsm
```

Without that, exporting says "no template".

## 4. Phones

Each tech: open the site in Safari → Share → **Add to Home Screen** → open it
**from the icon**. Sign in with their email.

Worth doing once, together, before anyone goes to site.

---

## What is real now

- Sign in, sign up, password reset — against the server
- Points, verdicts, readings, checks, notes, address edits — saved server-side
- Defects and issues, with photos uploaded to the server
- Live updates between techs while both are online
- Offline queue on the phone, flushed when signal returns
- Export straight to a formatted `.xlsm` from Project settings

## Known rough edges

- **Work packages** live in the project's settings blob rather than their own
  table. Fine for a few; would not scale to hundreds.
- **Team activity** on the project settings screen counts local events, so it
  under-reports what other people have done until you refresh.
- **The export button is lead-only by convention, not enforcement** — any
  member can press it. It is read-only, so the risk is noise, not damage.
- **First sync after a long offline stretch is sequential**, one event at a
  time. Forty points takes a few seconds. Deliberate: order matters for the
  audit trail.

## If tomorrow goes wrong

The Smartsheet is still your fallback and nothing here has touched it. The
app's data is in the `pb_data` volume; take a backup before the day starts:

```bash
make backup
```

If a tech cannot sign in, check `active` is ticked on their user record. If
they see no projects, they were not added as a member — re-run the seed with
their email in `--members`, or add the row in the dashboard.
