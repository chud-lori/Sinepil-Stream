# Deployment Guide

## Prerequisites

On your server:
- Docker + Docker Compose
- Nginx
- A domain pointed to the server (via Cloudflare, orange cloud / proxied)
- GitHub deploy key configured (see [Deploy Key Setup](#deploy-key-setup) below)

---

## First Deploy

**1. Clone the repo**
```bash
git clone github-sinepilstream:chud-lori/Sinepil-Stream.git
cd Sinepil-Stream
```

**2. Start the app**
```bash
docker compose up -d --build
```

Verify:
```bash
docker ps
docker logs sinepilstream
```

**3. Configure Nginx**

Create `/etc/nginx/sites-available/sinepilstream`:
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3500;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Enable and reload:
```bash
sudo ln -s /etc/nginx/sites-available/sinepilstream /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**4. Cloudflare Settings**

- DNS A record → your server IP, proxy **enabled** (orange cloud)
- SSL/TLS mode → **Flexible** (Cloudflare to server is plain HTTP on port 80)

---

## Updating (Re-deploy)

```bash
cd Sinepil-Stream
git pull origin main
docker compose up -d --build
```

> **Note on `better-sqlite3`:** this is a native C++ addon. The Dockerfile installs
> `python3 make g++` during the build step so it compiles correctly inside the Alpine
> container. You don't need anything extra on the host — Docker handles it.

---

## Persistent Data (SQLite)

Movie data is stored in a **Docker named volume** (`sinepilstream_data`), managed by
Docker at `/var/lib/docker/volumes/sinepilstream_data/`. It is completely separate from
the project directory, so it survives:

- `git pull` / re-clone
- `docker compose up -d --build` (rebuild)
- Moving or deleting the project folder

The only way to lose it is explicitly running `docker volume rm sinepilstream_data`
or `docker compose down -v` (the `-v` flag removes volumes — never use it in prod).

To inspect the DB on the server:
```bash
docker exec sinepilstream node -e "
const db = require('better-sqlite3')('/app/data/movies.db');
console.log('total:', db.prepare('SELECT COUNT(*) AS n FROM movies').get().n);
"
```

To back up the DB:
```bash
docker cp sinepilstream:/app/data/movies.db ./movies.db.bak
```

To restore a backup:
```bash
docker cp ./movies.db.bak sinepilstream:/app/data/movies.db
```

---

## Deploy Key Setup

Use this if the repo is private or you want key-based auth instead of HTTPS.

**1. Generate a key on the server**
```bash
ssh-keygen -t ed25519 -C "sinepilstream-deploy" -f ~/.ssh/sinepilstream_deploy
```

**2. Add the public key to GitHub**

Copy the public key:
```bash
cat ~/.ssh/sinepilstream_deploy.pub
```

Go to: GitHub repo → Settings → Deploy keys → Add deploy key  
Paste the public key. Read-only access is sufficient.

**3. Add SSH config alias**

Append to `~/.ssh/config`:
```
Host github-sinepilstream
    HostName github.com
    User git
    IdentityFile ~/.ssh/sinepilstream_deploy
```

**4. Test**
```bash
ssh -T github-sinepilstream
```

Should return: `Hi chud-lori/Sinepil-Stream! You've successfully authenticated...`

Then clone using the alias:
```bash
git clone github-sinepilstream:chud-lori/Sinepil-Stream.git
```

---

## Logs

```bash
# Live logs
docker logs -f sinepilstream

# App log files (mounted volume)
tail -f logs/app.log
```

## Stop / Restart

```bash
docker compose down        # stop
docker compose up -d       # start (no rebuild)
docker compose up -d --build  # start with rebuild
```
