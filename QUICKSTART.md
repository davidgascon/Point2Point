# Quickstart — behind Nginx Proxy Manager

This stack does not do TLS. Your NPM already does. It publishes one port;
you point one proxy host at it.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # log out and back in

git clone <your repo> /opt/field-checkout
cd /opt/field-checkout
./setup.sh
```

`setup.sh` asks for a host port and your public URL, builds, starts, confirms
the schema applied, creates your dashboard admin, then prints the exact NPM
settings to enter.

## The NPM proxy host

| Field | Value |
|---|---|
| Domain | `checkout.yourdomain.com` |
| Scheme | `http` |
| Forward hostname | the Docker host's IP |
| Forward port | `8080` (or whatever you chose) |
| Websockets support | **on** |
| Block common exploits | on |
| SSL | request a certificate, Force SSL, HTTP/2 |

### One thing you must add

In that proxy host's **Advanced** tab:

```nginx
location /api/realtime {
    proxy_pass http://HOST_IP:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

PocketBase's realtime updates are server-sent events. NPM buffers by default,
which holds the stream open but delivers nothing — so live updates between
techs silently never arrive and everything else looks fine. This is the one
gotcha in the whole setup.

### If NPM is in its own compose stack

Routing container-to-container is tidier than going out through a host port.
Uncomment the `networks:` block at the bottom of `docker-compose.yml`, put
this stack on NPM's network, and forward to `field-checkout-web` port `8080`
instead of a host IP.

## What runs where

| Path | Goes to |
|---|---|
| `/` | the app |
| `/api/*` | PocketBase — auth, data, photos |
| `/_/*` | PocketBase dashboard |
| `/export/*` | the .xlsm export service |

One proxy host covers all of it; the internal nginx sorts out the rest.

## Day to day

```bash
make            # list commands
make health     # local ports and the public URL
make logs
make app FILE=field_checkout.html   # publish a build, bumps the SW cache
make deploy     # git pull + publish + rebuild + health
make backup     # snapshot into ./backups
make restore FILE=backups/pb_2026-09-21.tar.gz
```

## After setup

1. **SMTP** — dashboard → Settings → Mail, send a test. Password reset does
   nothing until this works.
2. **Accounts** — dashboard → `users`. Initials must be unique; they are what
   lands in the Point To Point column of the sheet.
3. **Template** — `make template PROJECT=<id> FILE=KOKUSAI_P2P.xlsm TOKEN=<lead token>`
4. **Phones** — Safari → Share → Add to Home Screen → open from the icon.
   A Safari tab and the installed app keep separate storage.
5. **Backups in cron:**
   `15 2 * * * cd /opt/field-checkout && make backup >/dev/null 2>&1`

## Firewall

The app port only needs to be reachable from NPM, never from the internet.
If NPM is on another machine:

```bash
sudo ufw allow from <NPM_IP> to any port 8080 proto tcp
```

If NPM is on this machine, do not open it at all — Docker's bridge handles it.

## Troubleshooting

```bash
make health
make logs
```

- **502 in NPM** — wrong forward IP or port, or the stack is still starting.
  `curl http://localhost:8080/api/health` on the Docker host tells you which.
- **Live updates never arrive** — the `/api/realtime` block above is missing.
- **Password reset links point at localhost** — `PUBLIC_URL` in `.env` is wrong.
  Fix it and `docker compose up -d`.
- **Techs see an old version** — they are in a Safari tab, not the installed app.
