# SinepilStream

A self-hosted movie **and series** streaming app that scrapes content on the fly and presents it with a clean, ad-minimal interface.

## Features

- **Movies + TV series** from two upstream sources, unified in one UI
- **Netflix-style home rails** per genre/year, plus a "For You" recommendations rail
- **Recently Watched** rail — auto-resumes series at the last-watched episode
- Server-side **search across both kinds** via the shared upstream autocomplete API
- Multiple player sources per title, resolved at scrape time so tab switching is instant
- **Watch by URL** — paste any lk21 or nontondrama link to jump straight in
- Per-browser **history + wishlist** via `localStorage` (no account needed)
- **Source host failover** — rotates between mirror hosts when one goes down
- **SQLite response cache** with stale-while-revalidate (warm requests < 20 ms)
- **Security hardening** — Helmet CSP, SSRF/DNS-rebinding-safe outbound allowlist, per-IP rate limit

## Stack

- **Backend**: Node.js + Express 5
- **Scraping**: Axios + Cheerio
- **Storage**: `better-sqlite3` (movies + series index, cache, rating cache)
- **Frontend**: Vanilla JS + `localStorage`
- **Deploy**: Docker + Nginx

## Local development

```bash
npm install
npm run dev
```

App runs at **http://localhost:3000** (use `PORT=…` to override).

If the native sqlite module fails on startup (`NODE_MODULE_VERSION`), run:

```bash
npm rebuild better-sqlite3
```

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, module layout, request flows, recommendations algorithm.
- **[SCRAPING.md](SCRAPING.md)** — upstream source integration, anti-scraping bypass techniques.
- **[DEPLOY.md](DEPLOY.md)** — Docker + Nginx production setup.
