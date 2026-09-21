#!/usr/bin/env bash
# Field Checkout — one-command setup.
#
#   ./setup.sh              interactive
#   ./setup.sh --lan        skip the domain, serve plain HTTP on :8080
#
# Safe to re-run: it will not overwrite an existing .env without asking.
set -euo pipefail

cd "$(dirname "$0")"
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

say "${BOLD}Field Checkout — setup${OFF}"
say ""

# ------------------------------------------------------------ prerequisites
command -v docker >/dev/null || die "Docker is not installed. See README step 1."
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing."
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Try: sudo usermod -aG docker \$USER, then log out and back in."
ok "Docker is ready"

LAN_ONLY=0
[[ "${1:-}" == "--lan" ]] && LAN_ONLY=1

# ---------------------------------------------------------------- .env
if [[ -f .env ]]; then
  say ""
  read -rp "A .env already exists. Keep it? [Y/n] " keep
  [[ "${keep,,}" == "n" ]] && rm -f .env
fi

if [[ ! -f .env ]]; then
  say ""
  if [[ $LAN_ONLY -eq 1 ]]; then
    APP_DOMAIN="lan.invalid"; TLS_EMAIL="none@example.com"
    warn "LAN mode: plain HTTP on port 8080, no certificate."
  else
    say "${DIM}The domain must already have an A record pointing at this machine.${OFF}"
    read -rp "Domain (blank for LAN-only on :8080): " APP_DOMAIN
    if [[ -z "$APP_DOMAIN" ]]; then
      LAN_ONLY=1; APP_DOMAIN="lan.invalid"; TLS_EMAIL="none@example.com"
      warn "LAN mode: plain HTTP on port 8080, no certificate."
    else
      read -rp "Email for certificate expiry notices: " TLS_EMAIL
    fi
  fi

  cat > .env <<EOF
APP_DOMAIN=$APP_DOMAIN
TLS_EMAIL=$TLS_EMAIL
PB_VERSION=${PB_VERSION:-0.29.3}
EOF
  ok "Wrote .env"
fi

set -a; source .env; set +a
[[ "$APP_DOMAIN" == "lan.invalid" ]] && LAN_ONLY=1

# ------------------------------------------------------------- DNS check
if [[ $LAN_ONLY -eq 0 ]]; then
  say ""
  if command -v dig >/dev/null; then
    RESOLVED=$(dig +short "$APP_DOMAIN" | tail -1 || true)
    PUBLIC=$(curl -s --max-time 5 https://api.ipify.org || echo "")
    if [[ -z "$RESOLVED" ]]; then
      warn "$APP_DOMAIN does not resolve yet."
      warn "Certificate issuance will fail, and failed attempts are rate-limited."
      read -rp "Carry on anyway? [y/N] " go
      [[ "${go,,}" == "y" ]] || die "Stopping. Fix DNS and re-run."
    elif [[ -n "$PUBLIC" && "$RESOLVED" != "$PUBLIC" ]]; then
      warn "$APP_DOMAIN resolves to $RESOLVED but this host appears to be $PUBLIC."
      read -rp "Carry on anyway? [y/N] " go
      [[ "${go,,}" == "y" ]] || die "Stopping. Fix DNS and re-run."
    else
      ok "DNS points here ($RESOLVED)"
    fi
  else
    warn "dig not installed, skipping the DNS check"
  fi
fi

# ------------------------------------------------------------------ build
say ""
say "${BOLD}Building and starting${OFF} ${DIM}(first run pulls images, give it a few minutes)${OFF}"
docker compose up -d --build

# ----------------------------------------------------------------- health
say ""
printf "Waiting for the backend"
for i in $(seq 1 60); do
  if docker compose exec -T pocketbase wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1; then
    printf '\n'; ok "Backend is up"; break
  fi
  printf '.'; sleep 2
  [[ $i -eq 60 ]] && { printf '\n'; die "Backend did not come up. Run: docker compose logs pocketbase"; }
done

# ------------------------------------------------------------- collections
MISSING=0
for c in projects project_members points events issues; do
  docker compose exec -T pocketbase sh -c \
    "wget -qO- 'http://127.0.0.1:8090/api/collections/$c/records?perPage=1' 2>/dev/null | grep -q . " \
    || MISSING=1
done
if [[ $MISSING -eq 0 ]]; then
  ok "Schema applied"
else
  warn "Could not confirm the schema. Check: docker compose logs pocketbase | tail -40"
  warn "PocketBase changes its migration API between versions; see README step 4."
fi

# ----------------------------------------------------------- admin account
say ""
say "${BOLD}Server admin${OFF} ${DIM}(the dashboard login, separate from app accounts)${OFF}"
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

# ------------------------------------------------------------------- done
if [[ $LAN_ONLY -eq 1 ]]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  URL="http://${IP:-localhost}:8080"
else
  URL="https://$APP_DOMAIN"
fi

say ""
say "${BOLD}Running.${OFF}"
say "  App        $URL"
say "  Dashboard  $URL/_/"
say ""
say "${BOLD}Next${OFF}"
say "  1. Dashboard → Settings → Mail, add SMTP and send a test."
say "     Password reset does nothing until this works."
say "  2. Dashboard → users, add your team. Initials must be unique —"
say "     they are what lands on the P2P sheet."
say "  3. make template PROJECT=<id> FILE=KOKUSAI_P2P.xlsm"
say "  4. On each iPhone: open $URL in Safari, Share, Add to Home Screen,"
say "     then open it from the icon, not from Safari."
say "  5. make backup   (then put it in cron — see the README)"
if [[ $LAN_ONLY -eq 1 ]]; then
  say ""
  warn "LAN mode has no HTTPS, so the offline install will not work on phones."
  warn "Service workers need a secure origin. Use a domain, or Tailscale, for real use."
fi
say ""
say "${DIM}make help  for everything else${OFF}"
