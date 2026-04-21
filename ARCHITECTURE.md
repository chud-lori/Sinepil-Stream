# SinepilStream — Architecture

This document describes the system design, module layout, request flows, and the recommendations algorithm. For how we talk to the upstream source sites, see [SCRAPING.md](SCRAPING.md). For how we ship to production, see [DEPLOY.md](DEPLOY.md).

---

## 1. High-level view

```
                ┌────────────────┐
                │  User browser  │
                │  (SPA, vanilla │
                │   JS + LS)     │
                └────┬──────┬────┘
                     │      │
            HTTP    │      │  iframe src
                     │      │  (direct or
                     ▼      │   via /api/proxy)
               ┌──────────┐ │
               │  Nginx   │ │
               └────┬─────┘ │
                    │       │
               ┌────▼───────▼──────────────────┐
               │  Express app (server.js)      │
               │  ├── helmet (CSP / HSTS / …)  │
               │  ├── express-rate-limit 120/m │
               │  └── routes → lib/*           │
               └────┬──────────────────────────┘
                    │
          ┌─────────┴─────────┐
          │   lib/cache.js    │  ← SQLite-backed response cache (SWR, coalescing)
          └─────────┬─────────┘
                    │  miss
          ┌─────────▼─────────┐
          │   lib/index.js    │  (facade)
          │                   │
          │  ┌──────┬──────┐  │
          │  │movies│series│  │
          │  └───┬──┴───┬──┘  │
          └──────┼──────┼─────┘
                 │      │
      ┌──────────▼──────▼───────────┐
      │  lib/sources/*              │
      │   - lk21 movie scraper      │
      │   - nontondrama series      │
      │   - movies-host failover    │
      └──────────┬──────────────────┘
                 │
         Axios + Cheerio (HTTP + HTML)
                 │
         ┌───────▼───────────────┐
         │ Upstream sources      │
         │  lk21official.cc      │
         │  nontondrama.my       │
         │  gudangvape.com       │
         │  playeriframe.sbs     │
         └───────────────────────┘
```

The browser is a thin SPA. All logic that talks to the source sites lives on our server. The browser only ever talks to our Express app (for data) or — when embedding a video — directly to a whitelisted embed host (so the Cloudflare JS challenge runs in the real browser, not on our server).

---

## 2. Module layout

```
server.js                          # HTTP surface: routes, middleware, static assets
scraper.js                         # Backwards-compat shim → re-exports lib/
lib/
  index.js                         # Unified facade — single public API
  db.js                            # SQLite schema + prepared statements
  cache.js                         # response_cache table + cached() wrapper
  resolver.js                      # playeriframe.sbs → inner iframe src
  security.js                      # SSRF / DNS-rebinding / host allowlist
  http.js                          # Shared axios + cheerio helpers
  sources/
    movies.js                      # lk21 scraper — getMovie, browse, search, searchSeries
    movies-host.js                 # Candidate-host probing + failover
    series.js                      # nontondrama scraper — getSeries, getEpisode, browse
public/
  index.html                       # SPA shell
  app.js                           # SPA logic (no framework)
  style.css                        # Styles
data/
  movies.db                        # SQLite: movies + series + response_cache
```

**Design principles:**
- **Source-agnostic facade.** `lib/index.js` is the only module the rest of the app talks to. Adding a third source would not require changes outside `lib/`.
- **Cache at the facade boundary.** `cached()` wraps `getMovie`, `getSeries`, `getEpisode`, `browse`, `browseSeries` — not the lower-level HTTP calls. That way the cached unit is a full API response, keyed by something meaningful to the client (slug, path).
- **Validation at the edge.** Every slug that gets interpolated into a source URL passes `isSafeSlug()` (`^[a-z0-9][a-z0-9-]{0,199}$`). Every browse path passes `isSafeBrowsePath()`. Every outbound proxy URL passes `assertSafeOutboundUrl()`.
- **No framework on the frontend.** Event delegation, `data-action` attributes, `localStorage` for state — small enough that a framework would cost more than it saves.

---

## 3. Storage

Single SQLite file at `data/movies.db`. All schema is created with `CREATE TABLE IF NOT EXISTS` at boot (`lib/db.js` and `lib/cache.js`).

| Table             | Purpose                                                                    |
|-------------------|----------------------------------------------------------------------------|
| `movies`          | Movie index (slug, title, poster, rating, year, genre, indexed_at)         |
| `series`          | Series index (+ total_seasons, total_episodes)                             |
| `response_cache`  | Opaque JSON blobs keyed by `movie:<slug>` / `series:<slug>` / `browse:…`   |

- Index entries outside the last **60 days** get auto-cleaned daily.
- Response-cache entries past their `expires_at` get auto-cleaned daily.
- WAL mode, foreign keys on.

---

## 4. HTTP surface

All routes live in `server.js`. Errors use a shared `sendErr()` so the response shape is consistent (`{ error: "message" }` with an appropriate status).

| Route                                        | Purpose                                                      |
|----------------------------------------------|--------------------------------------------------------------|
| `GET /api/movie/:slug`                       | Scrape + return one movie with resolved players              |
| `GET /api/series/:slug`                      | Series metadata + season tree                                |
| `GET /api/episode/:slug/:season/:episode`    | Episode's resolved player list                               |
| `GET /api/browse?path=…`                     | Movie listing page                                           |
| `GET /api/browse/series?path=…`              | Series listing page                                          |
| `GET /api/home?kind=movie|series`            | Batched rails response (parallel browse calls, cached)       |
| `GET /api/search?q=…&kind=…`                 | Unified movie + series search                                |
| `GET /api/slug-from-url?url=…`               | Parse an upstream URL into `{ kind, slug, season?, episode? }` |
| `GET /api/proxy?url=…`                       | CSP-stripping iframe proxy for embeds that can't be embedded directly |

Cross-cutting middleware, applied in order:

1. `app.set('trust proxy', 1)` — Nginx sits in front.
2. `helmet(...)` — CSP, HSTS, X-Content-Type-Options, Referrer-Policy.
3. `express-rate-limit` at 120 req/min per client IP on `/api/*`.
4. `express.static('public')` with short `Cache-Control` on HTML/CSS/JS, longer on images.

---

## 5. Request flow examples

### Cold `GET /api/movie/oppenheimer-2023`

1. Rate limiter bucket check → pass.
2. Route handler calls `scraper.getMovie('oppenheimer-2023')`.
3. Facade validates slug with `isSafeSlug()`, then `cached('movie:oppenheimer-2023', 30 * 60, () => movieSource.getMovie('oppenheimer-2023'))`.
4. Cache miss → in-flight Map coalesces concurrent callers → runs producer.
5. `movieSource.getMovie`:
   - `fetchWithFailover('/oppenheimer-2023/')` — `axios.get` against active host, retries once against next candidate on network error.
   - Cheerio parses HTML. Three series-detection checks. JSON-LD metadata extraction.
   - Player list extracted from anchor `data-url`s → `resolvePlayers()` fetches each wrapper in parallel, extracts inner iframe src, drops P2P.
6. Payload is JSON-serialised, written to `response_cache` with 30-min TTL, returned.

### Warm `GET /api/movie/oppenheimer-2023` (typical)

1. Rate limiter → pass.
2. Facade: cache hit → `JSON.parse(payload)` returned directly. ~10 ms.

### `GET /api/home?kind=movie`

1. Facade's `homeRails('movie')` runs ~8 `browse(path)` calls in parallel.
2. Each `browse()` is individually cached (SWR, 10 min) so the second call in the same minute returns instantly.
3. Rails with zero items (e.g. empty genre response) are filtered out.
4. Response is an array of `{ id, title, path, items }`.

### `GET /api/proxy?url=…`

1. `assertSafeOutboundUrl()`:
   - Parses URL, checks scheme is `http:` / `https:`.
   - Checks hostname is in `EMBED_HOST_ALLOWLIST` (`playeriframe.sbs`, `emturbovid.com`, `f16px.com`, `short.icu`).
   - Resolves hostname → refuses if any A/AAAA points to a private range (`127.0.0.0/8`, `10/8`, `169.254.0.0/16`, `fc00::/7`, etc.). Defeats DNS rebinding.
2. Fetches target HTML with source-site Referer.
3. Strips `<meta http-equiv="Content-Security-Policy">` tags and known ad-script tags.
4. Injects `<base href>` + `SPOOF_SCRIPT` (referrer override + popup blocker).
5. Sends without `Content-Security-Policy` / `X-Frame-Options` so our domain can embed the result.

---

## 6. Caching strategy

Two independent cache layers serve different purposes:

### SQLite `response_cache` (server-side)

Wraps individual endpoints via `cached(key, ttl, producer, { staleWhileRevalidate })` in `lib/cache.js`.

| Endpoint         | TTL   | SWR? |
|------------------|-------|------|
| `getMovie`       | 30 m  | no   |
| `getSeries`      | 30 m  | no   |
| `getEpisode`     | 10 m  | no   |
| `browse`         | 10 m  | yes  |
| `browseSeries`   | 10 m  | yes  |
| `/api/home`      | inherits from underlying `browse*` calls |

**Stale-while-revalidate** (browse only): if the cache entry is expired but within a 1-hour grace window, we serve the stale value immediately and refresh in the background. Keeps browsing snappy during upstream slowness.

**In-flight coalescing**: a `Map<key, Promise>` ensures concurrent cold requests for the same key produce one upstream call. 50 simultaneous `getMovie(X)` → 1 upstream fetch.

### Browser `localStorage` (client-side)

| Key                    | Shape                                  |
|------------------------|----------------------------------------|
| `spilstream_history`   | Array of watched items (most recent first, capped at 200). Each entry has `slug, title, poster, year, rating, genre, kind, watched_at`, plus `lastSeason / lastEpisode` for series. |
| `spilstream_wishlist`  | Array of saved items with `added_at`.  |

Per-browser, per-device. No server-side identity. A migration on boot (`migrateKinds()` in `app.js`) adds `kind: 'movie'` to legacy entries.

---

## 7. Frontend architecture

Single-page app, no framework.

### Sections (`public/index.html`)

- `nav` — logo, search, tab buttons (Movies / Series / History / Wishlist)
- `#browse-bar` + `#series-filter-bar` — genre/year filters per kind
- `#url-bar` — "Watch by URL" input
- `main` — section container with:
  - `#sec-browse` — Movies tab (home rails + Recently Watched + filter-view flat grid)
  - `#sec-series` — Series tab (mirror of above)
  - `#sec-search` — search results
  - `#sec-history`, `#sec-wishlist`
- Modal overlay with player / episode picker / info / action buttons

### State (`public/app.js`)

A small set of module-level variables hold the current modal state:

```js
let currentMovie    = null;      // Active record in modal (movie or series)
let currentKind     = 'movie';
let currentSeries   = null;      // Full series record when kind === 'series'
let currentEpisode  = null;      // { season, episode } when an episode is loaded
let currentPlayers  = [];
let activeTab       = 'browse';
```

### Event handling

Strict CSP (`script-src-attr 'none'`) forbids inline handlers. Every interactive element carries `data-action="…"`; a single document-level click listener dispatches via a `CLICK_ACTIONS` registry. Change events route by element id. This keeps the UI CSP-safe and inspectable.

### Routing

No router library. `/movie/:slug` and `/series/:slug` open the modal via `init()` on first load and `popstate` on back/forward. Modal close pushes `/` back.

---

## 8. Security layers

| Layer                     | What it does                                                              | Where                      |
|---------------------------|---------------------------------------------------------------------------|----------------------------|
| **CSP + HSTS + headers**  | Helmet with `script-src 'self' 'unsafe-inline'`, strict `script-src-attr`, `frame-ancestors 'self'` | `server.js`                |
| **Rate limit**            | 120 req/min per IP on `/api/*` (token bucket)                            | `server.js`                |
| **SSRF guard**            | Private-IP refusal (IPv4 + IPv6 + cloud metadata), DNS rebinding check   | `lib/security.js`          |
| **Embed host allowlist**  | `/api/proxy` only forwards to 4 known embed hosts                         | `lib/security.js`          |
| **Slug validation**       | `^[a-z0-9][a-z0-9-]{0,199}$` before URL interpolation                   | `lib/index.js`             |
| **Browse path validation**| `^[a-z0-9/-]{0,100}$` before URL interpolation                          | `server.js`                |
| **Prepared SQL**          | All DB access via `db.prepare(...)`                                      | `lib/db.js`, `lib/cache.js`|
| **HTML escape**           | `esc()` on every scraped text field before DOM insertion                  | `public/app.js`            |

---

## 9. Source host failover

Upstream movie site rotates subdomains (`tv10` → `tv11` → …) and occasionally TLDs. `lib/sources/movies-host.js` owns this:

```js
const CANDIDATES = [
  'tv10.lk21official.cc',
  'tv11.lk21official.cc',
  'tv12.lk21official.cc',
  'tv13.lk21official.cc',
  'lk21official.cc',
  'lk21official.love',
  'lk21.party',
];
```

- On server boot, `selectActiveHost()` probes candidates in order (4 s timeout each, HEAD) and pins the first that responds.
- Outbound movie fetches go through `fetchWithFailover(path)` which, on a *network* error (not HTTP 4xx), rotates to the next candidate and retries once.
- Rotations log `[movie-source] failover: X → Y` so you see mirror health in the container logs.

---

## 10. Recommendations — "For You" rail

This is deliberately a **client-side, zero-data-out** system: everything runs in the browser from `localStorage`. No recommendations endpoint, no user identity on the server, no cross-user data sharing.

### Goals

- Make the Movies / Series home feel personal after a user has opened a few titles.
- Add **zero** server load.
- Work offline after the initial `/api/home` payload arrives.

### Inputs

- `History.all()` from `localStorage` (the user's watch history for this device).
- The rails we just fetched from `/api/home` — each card carries a `genre` string (comma-separated).

### Algorithm

1. **Preconditions**. Require `≥3` history entries of the target `kind`. Below that, skip the rail — we don't have enough signal, and showing a stale recommendation would be worse than showing nothing.
2. **Top-N genre profile**. Walk history, split each entry's `genre` on commas, lowercase, tally. Keep the **top 3** genres by count — that's the user's revealed preference.
3. **Candidate pool**. Union every item across every loaded rail. Dedup by slug. Exclude anything already in history (don't re-recommend what they've already opened).
4. **Score**. For each candidate, score = number of its genres that appear in the user's top-3 list. Range: 0–3.
5. **Rank**. Sort by score descending, drop zero-score items, take top 20.
6. **Render**. Prepend to the rails as `{ id: 'recs', title: 'For You', items: [...] }`.

```js
// public/app.js, simplified
function buildRecommendations(rails, kind) {
  const history = History.all().filter(h => (h.kind || 'movie') === kind);
  if (history.length < 3) return null;

  const topGenres = topGenresFromHistory(kind);            // 1-2-3 most common
  const seenSlugs = new Set(history.map(h => h.slug));

  const candidates = new Map();
  for (const rail of rails) for (const item of rail.items) {
    if (seenSlugs.has(item.slug) || candidates.has(item.slug)) continue;
    const itemGenres = parseGenres(item.genre);
    const score = itemGenres.filter(g => topGenres.includes(g)).length;
    if (score > 0) candidates.set(item.slug, { item, score });
  }

  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(r => r.item);

  return ranked.length ? { id: 'recs', title: 'For You', items: ranked } : null;
}
```

### Why this approach

**Why client-side?**
No accounts means no server-side identity — there's nothing to key a recommendation against. Every user's history already lives in their browser. Shipping the computation there avoids a useless round-trip and eliminates any privacy concern (genres never leave the device).

**Why genre overlap, not collaborative filtering?**
Collaborative filtering needs a user × item matrix. We have no cross-user signal because there's no account system. With zero shared data, content-based similarity over genre is the simplest thing that works, and genres are already in every card payload.

**Why lowercase-string set intersection?**
Source genre strings are a small, human-curated vocabulary (≈30 terms: `Action`, `Drama`, `Sci-Fi`, `Romance`, …). A full-text embedding model would be massive overkill. Set intersection is O(history × rail_items × genres_per_item), which for realistic numbers (≤200 history × ≤140 rail items × ≤5 genres) is <150 k comparisons — finishes in under 5 ms on a phone.

**Why top-3 genres?**
Gives room for a mixed taste (someone who watches Action + Comedy + Drama) while still being narrow enough that the recs feel targeted. Top-1 would be too monotonous; top-5 blurs the signal.

**Why rerank the existing rails instead of a separate fetch?**
We already paid for the `/api/home` payload — every card the user could be recommended is already in memory. Firing a second request just to produce the "For You" rail would duplicate the cost with no quality gain.

### Limitations (honest)

- **Cold start.** A brand-new user sees no "For You" rail until they've opened 3 titles. This is intentional; noise is worse than absence.
- **Opens, not completions.** Because we can't detect whether a video was watched to the end (cross-origin iframe), the signal is "clicked on", not "finished". See the last row of [SCRAPING.md §6](SCRAPING.md#6-what-we-cant-bypass).
- **Genre-only.** No signal from cast, director, year, or rating. Good enough for a first pass; could be extended by adding those into the score with small weights.
- **Rail-bound candidates.** Recommendations are drawn from items already on the home rails, so users never see a "hidden gem" that isn't on Latest / a loaded genre rail. If that becomes a problem, a follow-up could fire a second `/api/home?expand=1` request that pulls extra pages per top-genre and scores across that larger pool.

---

## 11. Adding a new source

The facade makes this a self-contained task:

1. Create `lib/sources/newsource.js` exporting `browse`, `search`, `getItem`, `getEpisode`, `seedIndex`, `parseSourceUrl`. Follow the shape of `movies.js` or `series.js`.
2. Add a new table to `lib/db.js` if the item shape differs enough to need its own index.
3. Wire it into `lib/index.js`:
   - Import as a named source.
   - Add route wrappers that call `cached(...)`.
   - Extend `homeRails()` with source-specific rails if needed.
   - Extend `search()` + `fromSourceUrl()` to include the new source.
4. Add the new embed hosts to `EMBED_HOST_ALLOWLIST` in `lib/security.js`.
5. Add server routes in `server.js`.
6. Add a UI tab + section in `public/index.html` + `public/app.js`.

No changes required in `lib/cache.js`, `lib/resolver.js`, or `lib/security.js` beyond the allowlist.
