# SinepilStream

A self-hosted movie streaming app that scrapes content on the fly and presents it with a clean, ad-minimal interface.

## Features

- On-the-fly scraping — no database, no scheduled jobs
- Multiple player sources with instant tab switching (all resolved at page load)
- Per-browser watch history and wishlist via `localStorage` — no account needed
- In-memory movie index seeded at startup for fast search
- Backend proxy for P2P players that block direct embedding

## Stack

- **Backend**: Node.js + Express 5
- **Scraping**: Axios + Cheerio
- **Frontend**: Vanilla JS + localStorage
- **Deploy**: Docker + Nginx + Cloudflare

## Local Development

```bash
npm install
npm run dev
```

App runs at `http://localhost:3500`

## Production

See [DEPLOY.md](DEPLOY.md) for full deployment guide.
