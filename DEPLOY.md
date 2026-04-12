# SinepilStream — Deployment Guide

Two deployment modes are available: **PM2** (zero-downtime, recommended) and **Docker** (blue-green, ~3 s window).

---

## Quick Start

```bash
# First-time setup (PM2)
make install

# Deploy latest code (zero-downtime)
make deploy
```

---

## PM2 Mode (Recommended)

PM2 is the primary deployment method. It provides **true zero-downtime reloads**: the new process must signal readiness before the old one is killed, so no requests are dropped.

### How it works

1. `pm2 reload` starts the new Node process alongside the old one.
2. The new process calls `process.send('ready')` after `app.listen()` completes.
3. PM2 receives the `ready` signal and routes all new traffic to the new process.
4. PM2 sends SIGINT to the old process; it finishes in-flight requests and exits cleanly.
5. If `ready` is not received within `listen_timeout` (12 s), PM2 aborts and keeps the old process.

### Prerequisites

```bash
npm install -g pm2
```

### First-time setup

```bash
make install
```

This runs `npm install --omit=dev`, creates `logs/` and `data/` directories, starts the app via PM2, saves the process list, and prints the `pm2 startup` command needed to survive reboots.

Run the printed `pm2 startup` command once (it requires sudo) to register the PM2 daemon as a system service.

### Deploy (zero-downtime)

```bash
make deploy
# or directly:
bash deploy.sh
```

Pulls latest code from `origin main`, installs dependencies, and runs `pm2 reload ecosystem.config.js --update-env`.

### Other PM2 targets

| Command | Effect |
|---------|--------|
| `make start` | Start the app (first time or after `make stop`) |
| `make stop` | Stop the app |
| `make restart` | Hard restart (brief downtime) |
| `make logs` | Tail PM2 logs (last 100 lines) |
| `make status` | Show PM2 process status |

### Configuration

`ecosystem.config.js` controls PM2 behaviour:

```js
{
  name:           'sinepilstream',
  script:         'server.js',
  instances:      1,          // single instance — SQLite doesn't support multi-process writes
  exec_mode:      'fork',
  wait_ready:     true,       // wait for process.send('ready') before cutting over
  listen_timeout: 12000,      // ms to wait for ready signal before aborting reload
  kill_timeout:   10000,      // ms to wait for in-flight requests before SIGKILL
  env: {
    NODE_ENV: 'production',
    PORT:     3500,
  },
  autorestart:        true,
  max_memory_restart: '300M',
  out_file:   './logs/out.log',
  error_file: './logs/error.log',
}
```

---

## Docker Mode

Docker deployment uses a **blue-green** pattern. A new container is started and health-checked before the old one is stopped, limiting downtime to the docker stop latency (~1–2 s).

### Prerequisites

- Docker Engine with the `docker compose` plugin (v2)

### Deploy

```bash
make docker-deploy
# or directly:
bash deploy.sh --docker
```

Steps performed:
1. `git pull origin main`
2. `docker compose build --no-cache`
3. Start a temporary "green" container on `PORT+1` for health checking
4. Poll `GET /api/browse` every second for up to 30 s
5. Stop and remove the old "blue" container
6. `docker compose up -d` — bring up the new image with correct volumes and restart policy

If the green container fails to start or fails the health check, it is removed and the old container continues serving.

### Other Docker targets

| Command | Effect |
|---------|--------|
| `make docker-build` | Build image only |
| `make docker-logs` | Tail container logs (last 100 lines) |
| `make docker-stop` | Stop and remove container (`docker compose down`) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3500` | HTTP port the server listens on |
| `NODE_ENV` | `production` | Node environment |

Set these in `ecosystem.config.js` (PM2) or `docker-compose.yml` (Docker).

---

## File Layout

```
sinepil-stream/
├── server.js             # Express app + API routes
├── scraper.js            # Scraping + SQLite index
├── ecosystem.config.js   # PM2 process definition
├── deploy.sh             # Deploy script (PM2 + Docker modes)
├── Makefile              # Convenience targets
├── data/
│   └── movies.db         # SQLite movie index (persistent)
├── logs/
│   ├── out.log           # PM2 stdout
│   └── error.log         # PM2 stderr
└── public/               # Static frontend (SPA)
```

### Data persistence

- `data/movies.db` — SQLite database containing the scraped movie index. **Do not delete.** It is populated incrementally; rebuilding it requires re-scraping all browse pages.
- `logs/` — rotating log files. Safe to delete if disk space is needed; PM2 will recreate them.

In Docker, mount `data/` as a named volume so the database survives container replacements:

```yaml
# docker-compose.yml
volumes:
  - sinepilstream_data:/app/data
```

---

## Graceful Shutdown

The server handles `SIGINT` (PM2 reload) and `SIGTERM` (docker stop) by:

1. Calling `server.close()` — stops accepting new connections, waits for in-flight requests.
2. Exiting cleanly once all connections are drained.
3. Force-exiting after 15 s if connections are stuck (e.g. long-lived keep-alive connections).

This ensures zero dropped requests during PM2 zero-downtime reloads.
