#!/usr/bin/env bash
# SinepilStream — zero-downtime deploy script
#
# Usage:
#   bash deploy.sh          # PM2 mode (default) — truly zero-downtime
#   bash deploy.sh --docker # Docker blue-green — ~3 s downtime window

set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-pm2}"
APP="sinepilstream"
PORT="${PORT:-3500}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}>>>${NC} $*"; }
warn()    { echo -e "${YELLOW}>>>${NC} $*"; }
die()     { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

# ── PM2 MODE (zero-downtime) ─────────────────────────────────────────────────
pm2_deploy() {
  command -v pm2 >/dev/null 2>&1 || die "pm2 not found. Install with: npm i -g pm2"

  info "Pulling latest code…"
  git pull origin main

  info "Installing dependencies…"
  npm install --omit=dev

  info "Creating required directories…"
  mkdir -p logs data

  if pm2 describe "$APP" >/dev/null 2>&1; then
    info "Reloading $APP (zero-downtime)…"
    # 'pm2 reload' starts the new process, waits for process.send('ready'),
    # then gracefully kills the old one — no dropped requests.
    pm2 reload ecosystem.config.js --update-env
  else
    info "Starting $APP for the first time…"
    pm2 start ecosystem.config.js --env production
    pm2 save  # persist process list so it survives server reboots
  fi

  info "Done."
  pm2 status "$APP"
}

# ── DOCKER MODE (blue-green, ~3 s window) ────────────────────────────────────
docker_deploy() {
  command -v docker >/dev/null 2>&1        || die "docker not found"
  command -v docker-compose >/dev/null 2>&1 \
    || command -v docker >/dev/null 2>&1    || die "docker compose not found"

  BLUE="$APP"
  GREEN="${APP}-green"

  info "Pulling latest code…"
  git pull origin main

  info "Building new image…"
  docker compose build --no-cache

  # Start green container on a temporary port so it can warm up
  TEMP_PORT=$((PORT + 1))
  info "Starting green container on port $TEMP_PORT for health check…"
  docker run -d --name "$GREEN" \
    --env-file <(docker inspect "$BLUE" --format='{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true) \
    -e PORT="$TEMP_PORT" \
    -p "${TEMP_PORT}:${TEMP_PORT}" \
    --mount "source=${APP}_data,target=/app/data" \
    "$(docker compose images -q "$APP" 2>/dev/null | head -1 || docker compose build -q)" \
    node server.js 2>/dev/null || {
      warn "Could not start green separately — falling back to compose restart (~3 s downtime)"
      docker compose down
      docker compose up -d
      info "Done."
      docker compose ps
      return
    }

  # Health check: wait up to 30 s for the new container to respond
  info "Health checking green container…"
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:${TEMP_PORT}/api/browse" >/dev/null 2>&1; then
      info "Green is healthy (${i}s)"
      break
    fi
    [ "$i" -eq 30 ] && { docker rm -f "$GREEN"; die "Green failed health check after 30s"; }
    sleep 1
  done

  # Atomic swap: stop blue, rename green (downtime = docker stop latency ~1-2 s)
  info "Swapping blue → green…"
  docker stop "$BLUE"  2>/dev/null || true
  docker rm   "$BLUE"  2>/dev/null || true
  docker stop "$GREEN" 2>/dev/null
  docker rm   "$GREEN" 2>/dev/null

  # Bring up cleanly with compose so volumes / restart policy are correct
  docker compose up -d

  info "Done."
  docker compose ps
}

# ── DISPATCH ─────────────────────────────────────────────────────────────────
case "$MODE" in
  --docker) docker_deploy ;;
  pm2|"")   pm2_deploy    ;;
  *)        die "Unknown mode '$MODE'. Use: bash deploy.sh [--docker]" ;;
esac
