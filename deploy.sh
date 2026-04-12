#!/usr/bin/env bash
# SinepilStream — deploy script
# Usage: bash deploy.sh
# Pulls latest code, rebuilds the Docker image, and restarts the container.

set -euo pipefail
cd "$(dirname "$0")"

APP="sinepilstream"
PORT="${PORT:-3500}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}>>>${NC} $*"; }
warn() { echo -e "${YELLOW}>>>${NC} $*"; }
die()  { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found"

info "Pulling latest code…"
git pull origin main

info "Building new image…"
docker compose build --no-cache

info "Restarting container…"
docker compose up -d --force-recreate

info "Done."
docker compose ps
