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

The container listens on **3500** in production (Nginx upstream), while local dev defaults to **3000** — don't confuse the two.

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
├── server.js                      # Express app + API routes + middleware
├── scraper.js                     # Backwards-compat shim → lib/
├── lib/
│   ├── index.js                   # Facade: unified movie + series API
│   ├── db.js                      # SQLite schema + prepared statements
│   ├── cache.js                   # Response-cache wrapper (SWR + coalescing)
│   ├── resolver.js                # playeriframe.sbs → inner player URL
│   ├── security.js                # SSRF guard, DNS rebinding, host allowlist
│   ├── http.js                    # Shared axios + cheerio helpers
│   └── sources/
│       ├── movies.js              # Movie source scraper
│       ├── movies-host.js         # Host-rotation failover
│       └── series.js              # Series source scraper
├── public/                        # Static SPA assets
├── Dockerfile
├── docker-compose.yml
├── deploy.sh / Makefile
├── data/                          # Mounted as named Docker volume
│   └── movies.db                  # Movies + series + cache table — do not delete
└── logs/                          # Bind-mounted from project dir
    ├── out.log
    └── error.log
```

### Data persistence

- `sinepilstream_data` (named volume) → `/app/data/movies.db` — SQLite database. Holds the movies and series index, response cache, and rating cache. Survives `docker compose down` and image rebuilds because it is a named volume, not a bind mount.
- `./logs` (bind mount) → `/app/logs` — log files written directly to the project directory on the host.

### Seeding on deploy

On every container start, `startSeeding()` (in `lib/index.js`) fires 2 s after the server listens. It warms the cache by scraping homepage + last 4 years for both sources. First user to hit the site after deploy sees a warm cache.
