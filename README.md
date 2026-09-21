# Field Checkout — deployment

Three containers behind Caddy on one Ubuntu VM.

| Service | What it does | Exposed |
|---|---|---|
| `caddy` | TLS, serves the app, proxies everything else | 80, 443 |
| `pocketbase` | accounts, database, realtime, admin dashboard | internal |
| `exporter` | writes data back into the original `.xlsm` | internal |

Only Caddy publishes ports. Nothing else on the VM is reachable from outside.

---

## Before you start

1. **A DNS A record** pointing your domain at the VM's public IP. Caddy cannot
   get a certificate without it, and Let's Encrypt rate-limits failed attempts —
   get the DNS right first.
2. **Ports 80 and 443 open** to the internet.
3. Roughly **2 GB RAM and 20 GB disk**. This is a small workload; the disk is
   for photos.

## 1. Install Docker

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER      # log out and back in
```

## 2. Configure

```bash
cd /opt && sudo git clone <your-repo> field-checkout && cd field-checkout
cp .env.example .env
nano .env                          # APP_DOMAIN, TLS_EMAIL, PB_VERSION
cp /path/to/field_checkout.html web/index.html
```

The `web/` folder holds the app: `index.html`, `sw.js`, `manifest.webmanifest`
and the icons.

## 3. Start

```bash
docker compose up -d --build
docker compose logs -f caddy       # watch the certificate get issued
```

## 4. Create the first admin

Open `https://your-domain/_/` and create the PocketBase superuser. This account
is **separate** from app accounts — it administers the server.

The schema migration runs automatically on first boot. Confirm you see
`projects`, `project_members`, `points`, `events` and `issues` under
Collections. If they are missing, check `docker compose logs pocketbase`.

> **Version note.** The migration is written against the PocketBase 0.23+
> JS API (`migrate((app) => …)`, `new Collection({…})`). PocketBase is pre-1.0
> and changes its API between minor versions. If the migration errors on boot,
> check the version you pinned in `.env` against
> <https://pocketbase.io/docs/js-migrations/> — or just build the five
> collections by hand in the dashboard using the migration file as the spec.
> It takes about fifteen minutes.

## 5. Create app accounts

In the dashboard, under `users`, add a record per person:

| Field | Notes |
|---|---|
| `email` | their work email — password resets go here |
| `password` | they change it on first sign-in |
| `name` | full name |
| `initials` | **unique.** This is what lands in the Point To Point column |
| `role` | `tech`, `lead` or `admin` |
| `active` | on |

Initials carry a unique index, because two people signing as `DG` would make
the record permanently ambiguous.

## 6. Email (needed for password resets)

Settings → Mail settings in the dashboard. Without SMTP configured, the
"forgot password" flow silently does nothing — an admin has to set passwords
by hand. Use your company relay or any transactional provider.

## 7. Upload each project's template

The exporter needs the original workbook to write into:

```bash
curl -X POST https://your-domain/export/template/<project_id> \
  -H "Authorization: Bearer <a lead's token>" \
  -F file=@KOKUSAI_P2P.xlsm
```

Exports then come back byte-identical in formatting — fonts, fills, all 61
conditional formatting rules, the macros — with only the sign-off cells written.

---

## Hardening worth doing

**Lock the dashboard down.** `/_/` is full administrative access. If your team
is on a VPN or a fixed office IP, restrict it in `caddy/Caddyfile`:

```caddyfile
handle /_/* {
    @admins remote_ip 203.0.113.0/24 100.64.0.0/10
    handle @admins {
        reverse_proxy pocketbase:8090
    }
    respond 404
}
```

**Firewall:**

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

**Unattended security updates:**

```bash
sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```

## Backups

Everything that matters is in the `pb_data` volume — database, photos, accounts.

```bash
# nightly, keep 30 days
docker run --rm -v field-checkout_pb_data:/data -v /backups:/out alpine \
  tar czf /out/pb_$(date +\%F).tar.gz -C /data .
find /backups -name 'pb_*.tar.gz' -mtime +30 -delete
```

Put that in root's crontab and **test a restore before you trust it.** Copy a
backup to a second machine and bring the stack up against it.

## Updating the app

```bash
cp new_field_checkout.html web/index.html
# bump CACHE in web/sw.js so phones pick it up
docker compose restart caddy
```

Phones get the new version the next time they open the app with signal. The
service worker is served no-cache specifically so this works.

## When something breaks

```bash
docker compose ps
docker compose logs --tail=100 pocketbase
docker compose logs --tail=100 caddy
curl -s https://your-domain/api/health
curl -s https://your-domain/export/health
```

**Certificate won't issue** — DNS is wrong, or 80/443 are blocked. Caddy needs
port 80 reachable to complete the challenge.

**Techs see stale data** — they are running a cached app. Confirm `sw.js` is
being served with `Cache-Control: no-store`, and that they installed to the home
screen rather than working in a Safari tab. The tab and the installed app keep
separate storage, and this is the single most common support call.

**Export says no template** — that project has not had its workbook uploaded
(step 7).
