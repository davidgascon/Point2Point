#!/usr/bin/env bash
# Field Checkout — setup. TLS and the public hostname are handled by your
# Nginx Proxy Manager; this just brings the stack up on a local port.
#
#   ./setup.sh          interactive
#
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

echo "${BOLD}Field Checkout — setup${OFF}"; echo

command -v docker >/dev/null || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing."
docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon. Try: sudo usermod -aG docker \$USER, then log out and back in."
ok "Docker is ready"

if [[ -f .env ]]; then
  read -rp "A .env already exists. Keep it? [Y/n] " keep
  [[ "${keep,,}" == "n" ]] && rm -f .env
fi

if [[ ! -f .env ]]; then
  echo
  read -rp "Host port for NPM to forward to [8080]: " APP_PORT
  APP_PORT=${APP_PORT:-8080}
  if ss -ltn 2>/dev/null | grep -q ":${APP_PORT} "; then
    warn "Something is already listening on ${APP_PORT}."
    read -rp "Pick another port: " APP_PORT
  fi
  read -rp "Public URL NPM will serve this on [https://checkout.example.com]: " PUBLIC_URL
  PUBLIC_URL=${PUBLIC_URL:-https://checkout.example.com}
  cat > .env <<EOF
APP_PORT=$APP_PORT
PUBLIC_URL=$PUBLIC_URL
PB_VERSION=${PB_VERSION:-0.29.3}
EOF
  ok "Wrote .env"
fi
set -a; source .env; set +a

echo; echo "${BOLD}Building and starting${OFF} ${DIM}(first run takes a few minutes)${OFF}"
docker compose up -d --build

printf "Waiting for the backend"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${APP_PORT}/api/health" >/dev/null 2>&1; then
    printf '\n'; ok "Stack is up on port ${APP_PORT}"; break
  fi
  printf '.'; sleep 2
  [[ $i -eq 60 ]] && { printf '\n'; die "Did not come up. Run: docker compose logs"; }
done

MISSING=0
for c in projects project_members points events issues; do
  curl -sf "http://localhost:${APP_PORT}/api/collections/${c}/records?perPage=1" >/dev/null 2>&1 || MISSING=1
done
if [[ $MISSING -eq 0 ]]; then ok "Schema applied"
else
  warn "Could not confirm the schema — check: docker compose logs pocketbase | tail -40"
  warn "PocketBase changes its migration API between versions; see README step 4."
fi

echo; echo "${BOLD}Server admin${OFF} ${DIM}(dashboard login, separate from app accounts)${OFF}"
read -rp "Admin email: " ADMIN_EMAIL
read -rsp "Admin password (8+ chars): " ADMIN_PW; echo
[[ ${#ADMIN_PW} -ge 8 ]] || die "Password needs at least 8 characters."
if docker compose exec -T pocketbase /pb/pocketbase superuser upsert "$ADMIN_EMAIL" "$ADMIN_PW" >/dev/null 2>&1; then
  ok "Admin created"
elif docker compose exec -T pocketbase /pb/pocketbase admin create "$ADMIN_EMAIL" "$ADMIN_PW" >/dev/null 2>&1; then
  ok "Admin created (older CLI)"
else
  warn "Could not create the admin from the CLI — do it in the browser on first visit."
fi

HOSTIP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<INFO

${BOLD}Running on port ${APP_PORT}.${OFF}

${BOLD}Add one proxy host in Nginx Proxy Manager${OFF}
  Domain           ${PUBLIC_URL#https://}
  Scheme           http
  Forward hostname ${HOSTIP:-<this host's IP>}
  Forward port     ${APP_PORT}
  Websockets       ON        (PocketBase realtime rides this path)
  Block exploits   ON
  SSL tab          request a cert, Force SSL, HTTP/2

${BOLD}Then, in that proxy host's Advanced tab, paste:${OFF}
  location /api/realtime {
      proxy_pass http://${HOSTIP:-HOST_IP}:${APP_PORT};
      proxy_http_version 1.1;
      proxy_set_header Connection '';
      proxy_buffering off;
      proxy_read_timeout 24h;
  }

  ${DIM}Without that, NPM buffers the realtime stream and live updates
  between techs never arrive.${OFF}

${BOLD}Next${OFF}
  1. Dashboard at ${PUBLIC_URL}/_/ → Settings → Mail, add SMTP, send a test.
  2. Same dashboard → users → add your team. Initials must be unique.
  3. make template PROJECT=<id> FILE=KOKUSAI_P2P.xlsm TOKEN=<lead token>
  4. Phones: open ${PUBLIC_URL} in Safari, Share, Add to Home Screen,
     then open it from the icon.
  5. make backup, then put it in cron.

${DIM}make help  for everything else${OFF}
INFO
