# Deploy day — runbook

Work top to bottom. Each step has a check; if the check fails, stop there
rather than pushing on.

---

## Before you touch the VM

- [ ] Domain picked, e.g. `checkout.yourdomain.com`
- [ ] **A record** pointing at the VM's public IP, and it has propagated:
      `dig +short checkout.yourdomain.com` returns your IP
- [ ] Ports 80 and 443 reachable from the internet
- [ ] SMTP details to hand (host, port, user, password) — without these,
      password reset silently does nothing
- [ ] The original `KOKUSAI_P2P.xlsm` on your laptop

DNS first, genuinely. Let's Encrypt rate-limits failed attempts, and the
usual deploy-day mistake is starting the stack before DNS resolves and then
being locked out of certificate issuance for an hour.

---

## 1. Base VM

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and back in so the group takes effect.

**Check:** `docker run --rm hello-world` works without `sudo`.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

---

## 2. Put the stack on the VM

```bash
sudo mkdir -p /opt/field-checkout && sudo chown $USER /opt/field-checkout
# copy the deploy/ folder up from your laptop:
#   scp -r deploy/* you@vm:/opt/field-checkout/
cd /opt/field-checkout
cp .env.example .env
nano .env        # APP_DOMAIN, TLS_EMAIL
```

**Check:** `ls web/index.html pocketbase/pb_migrations/*.js` lists both.

---

## 3. First start

```bash
docker compose up -d --build
docker compose logs -f caddy
```

Watch for `certificate obtained successfully`. Ctrl-C once you see it.

**Check:**

```bash
curl -sI https://checkout.yourdomain.com | head -1     # HTTP/2 200
curl -s  https://checkout.yourdomain.com/api/health    # {"code":200,...}
curl -s  https://checkout.yourdomain.com/export/health # {"ok":true,...}
```

If the certificate fails, it is almost always DNS or a blocked port 80.
`docker compose logs caddy` says which.

---

## 4. Backend admin + schema

Open `https://checkout.yourdomain.com/_/` and create the superuser. This is
the *server* admin, separate from app accounts.

**Check:** under Collections you see `projects`, `project_members`, `points`,
`events`, `issues`.

If they are missing, the migration did not run:

```bash
docker compose logs pocketbase | tail -40
```

PocketBase is pre-1.0 and moves its migration API between minor versions. If
it errored, either pin a version matching the migration or build the five
collections by hand in the dashboard — the migration file is a complete spec
and it is about fifteen minutes of clicking.

---

## 5. Email

Dashboard → Settings → Mail settings. Enter your SMTP details and use the
**Send test email** button.

**Check:** the test email arrives. Until it does, "forgot password" does
nothing and you are resetting passwords by hand forever.

---

## 6. Accounts

Dashboard → Collections → `users` → New record, one per person:

| field | value |
|---|---|
| email | their work email |
| password | temporary, they change it |
| name | full name |
| initials | **unique** — this is what lands on the P2P sheet |
| role | `tech`, `lead` or `admin` |
| active | on |

Make yourself `admin`. Make whoever runs the job `lead`.

**Check:** creating a second user with the same initials is rejected.

---

## 7. The template for exports

```bash
curl -X POST https://checkout.yourdomain.com/export/template/<project_id> \
  -H "Authorization: Bearer <lead token>" \
  -F file=@KOKUSAI_P2P.xlsm
```

**Check:** `{"ok":true,"bytes":...}`.

---

## 8. Phones

On each iPhone: open the site in Safari → Share → **Add to Home Screen** →
open it **from the icon**.

**Check, on the phone:**

- [ ] Opens from the icon with no Safari address bar
- [ ] Top bar is not clipped by the status bar
- [ ] Airplane Mode on → force quit → reopen → **it still opens**
- [ ] Verify a few points offline, watch the counter climb
- [ ] Airplane Mode off → reopen → queue drains

That offline test is the one that matters. If the app does not open in
Airplane Mode, the service worker did not register — check that the site is
HTTPS and that they opened it from the icon rather than a Safari tab.

---

## 9. Backups, before anyone does real work

```bash
sudo mkdir -p /backups
sudo tee /usr/local/bin/fc-backup >/dev/null <<'EOF'
#!/bin/bash
docker run --rm -v field-checkout_pb_data:/data -v /backups:/out alpine \
  tar czf /out/pb_$(date +%F).tar.gz -C /data .
find /backups -name 'pb_*.tar.gz' -mtime +30 -delete
EOF
sudo chmod +x /usr/local/bin/fc-backup
sudo crontab -l 2>/dev/null | { cat; echo "15 2 * * * /usr/local/bin/fc-backup"; } | sudo crontab -
sudo /usr/local/bin/fc-backup
```

**Check:** `ls -la /backups` shows a tarball. Then actually restore it
somewhere else once. A backup you have never restored is a hope, not a backup.

---

## 10. Lock down the dashboard

`/_/` is full administrative access to everything. If your team is on a fixed
IP or a VPN, restrict it in `caddy/Caddyfile`:

```caddyfile
handle /_/* {
    @admins remote_ip 203.0.113.0/24 100.64.0.0/10
    handle @admins {
        reverse_proxy pocketbase:8090
    }
    respond 404
}
```

Then `docker compose restart caddy`.

---

## What is live after this, and what is not

**Working:** HTTPS, installable app on the phones, offline app shell, real
accounts with real password resets, the admin dashboard, the export service
with your template loaded.

**Not yet:** the app still reads and writes its own simulated data. Sign-in
accepts the demo accounts, not the ones you just created, and nothing syncs
between phones. That is the client data layer, and it is the next piece of
work — roughly: swap `pushEvents`, `pull`, `liveTick` and the auth handlers
for PocketBase SDK calls, move photos to the `issues.photos` file field, and
point export at `/export/p2p/<project>`.

Deploying now is still worth it: it proves DNS, TLS, the install flow, the
offline behaviour and email on real phones — which are the things that
surprise you — before any real data depends on them.
