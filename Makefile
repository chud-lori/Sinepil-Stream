# SinepilStream — convenience targets
# Run `make help` to see all commands.

APP  = sinepilstream
PORT = 3500

.PHONY: help deploy docker-deploy start stop restart logs status \
        docker-build docker-logs docker-stop install

help:
	@echo ""
	@echo "  SinepilStream — available targets"
	@echo ""
	@echo "  PM2 (zero-downtime, default deployment):"
	@echo "    make install        First-time setup: install deps + start via PM2"
	@echo "    make deploy         Pull latest code + zero-downtime PM2 reload"
	@echo "    make start          Start the app (PM2)"
	@echo "    make stop           Stop the app (PM2)"
	@echo "    make restart        Hard restart (brief downtime)"
	@echo "    make logs           Tail PM2 logs"
	@echo "    make status         Show PM2 process status"
	@echo ""
	@echo "  Docker:"
	@echo "    make docker-deploy  Pull + build + blue-green swap"
	@echo "    make docker-build   Build Docker image only"
	@echo "    make docker-logs    Tail Docker container logs"
	@echo "    make docker-stop    Stop and remove Docker container"
	@echo ""

# ── PM2 targets ──────────────────────────────────────────────────────────────

install:
	npm install --omit=dev
	mkdir -p logs data
	pm2 start ecosystem.config.js --env production
	pm2 save
	pm2 startup || true   # print the command needed to survive reboots

deploy:
	@bash deploy.sh pm2

start:
	pm2 start ecosystem.config.js --env production

stop:
	pm2 stop $(APP)

restart:
	pm2 restart $(APP) --update-env

logs:
	pm2 logs $(APP) --lines 100

status:
	pm2 status $(APP)

# ── Docker targets ────────────────────────────────────────────────────────────

docker-deploy:
	@bash deploy.sh --docker

docker-build:
	docker compose build

docker-logs:
	docker compose logs -f --tail=100

docker-stop:
	docker compose down
