# SinepilStream — Deployment Guide

The server runs the app in a **Docker container** exposed via **Nginx** as a reverse proxy.

---

## Deploy

```bash
make deploy
```

This pulls the latest code from `origin main`, rebuilds the Docker image, and restarts the container with `--force-recreate`. Nginx keeps accepting requests during the build; downtime is limited to the container restart (~2–3 s).

Or run the script directly:

```bash
bash deploy.sh
```

---

## Other commands

| Command | Effect |
|---------|--------|
| `make build` | Build Docker image only (no restart) |
| `make logs` | Tail container logs (last 100 lines) |
| `make restart` | Restart the container (no rebuild) |
| `make stop` | Stop and remove the container |
| `make status` | Show container status |

---

## First-time setup

```bash
docker compose up -d
```

The named volume `sinepilstream_data` is created automatically on first run and persists across deploys.

---

## Docker Compose

```yaml
services:
  sinepilstream:
    build: .
    container_name: sinepilstream
    restart: unless-stopped
    ports:
      - "3500:3500"
    environment:
      - NODE_ENV=production
      - PORT=3500
    volumes:
      - sinepilstream_data:/app/data   # SQLite DB — persists across deploys
      - ./logs:/app/logs

volumes:
  sinepilstream_data:
```

---

## Nginx config (example)

```nginx
server {
    listen 80;
    server_name sinepil.lori.my.id;

    location / {
        proxy_pass         http://localhost:3500;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## File layout

```
sinepil-stream/
├── server.js             # Express app + API routes
├── scraper.js            # Scraping + SQLite index
├── Dockerfile
├── docker-compose.yml
├── deploy.sh             # Deploy script
├── Makefile              # Convenience targets
├── data/                 # Mounted as named Docker volume
│   └── movies.db         # SQLite movie index — do not delete
└── logs/                 # Bind-mounted from project dir
    ├── out.log
    └── error.log
```

### Data persistence

- `sinepilstream_data` (named volume) → `/app/data/movies.db` — SQLite database. Survives `docker compose down` and rebuilds because it is a named volume, not a bind mount.
- `./logs` (bind mount) → `/app/logs` — log files written directly to the project directory on the host.
