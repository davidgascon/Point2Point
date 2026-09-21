# Quickstart

On a fresh Ubuntu VM, with a domain already pointing at it:

```bash
# 1. Docker, once
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # log out and back in

# 2. The stack
cd /opt && sudo git clone <repo> field-checkout && sudo chown -R $USER field-checkout
cd field-checkout
./setup.sh
```

`setup.sh` checks Docker, checks your DNS actually points here, writes `.env`,
builds and starts everything, waits for the backend, confirms the schema
applied, and creates your dashboard admin. It is safe to re-run.

**No domain yet?** `./setup.sh --lan` serves plain HTTP on `:8080` so you can
click around. Phones will not be able to install it offline — service workers
need HTTPS — but everything else works.

## Day to day

```bash
make            # list the commands
make health     # is everything answering
make logs       # tail everything
make app FILE=field_checkout.html   # publish a new build, bumps the SW cache
make backup     # snapshot database + photos into ./backups
make restore FILE=backups/pb_2026-09-21.tar.gz
make update     # pull newer images and rebuild
```

## After setup.sh

1. **SMTP** — dashboard → Settings → Mail, then send a test. Password reset
   does nothing until this works.
2. **Accounts** — dashboard → `users`. Initials must be unique; they are what
   lands in the Point To Point column.
3. **Template** — `make template PROJECT=<id> FILE=KOKUSAI_P2P.xlsm TOKEN=<lead token>`
4. **Phones** — Safari → Share → Add to Home Screen → open from the icon.
   The tab and the installed app keep separate storage; this trips everyone up once.
5. **Backups in cron:**
   ```
   15 2 * * * cd /opt/field-checkout && make backup >/dev/null 2>&1
   ```
   Then restore one somewhere else before you trust it.

## If something is wrong

```bash
make health
make logs-pb
```

- **No certificate** — DNS is wrong or port 80 is blocked. `make logs` says which.
- **Techs see an old version** — they are in a Safari tab, not the installed app.
- **Export says no template** — that project has not had step 3 done.
