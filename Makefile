# SinepilStream — convenience targets
# Run `make help` to see all commands.

APP  = sinepilstream
PORT = 3500

.PHONY: help deploy build logs stop restart status

help:
	@echo ""
	@echo "  SinepilStream — available targets"
	@echo ""
	@echo "    make deploy   Pull latest code + build + restart container"
	@echo "    make build    Build Docker image only"
	@echo "    make logs     Tail container logs"
	@echo "    make stop     Stop and remove container"
	@echo "    make restart  Restart container"
	@echo "    make status   Show container status"
	@echo ""

deploy:
	@bash deploy.sh

build:
	docker compose build

logs:
	docker compose logs -f --tail=100

stop:
	docker compose down

restart:
	docker compose restart $(APP)

status:
	docker compose ps
