# How SinepilStream Scraping Works

SinepilStream scrapes [lk21official.cc](https://lk21official.cc) — a WordPress-based movie catalogue — and serves the content through a clean, ad-minimal interface. This document explains the full scraping pipeline and how each anti-scraping measure is bypassed.

---

## Overview

```
User browser
    │
    │  HTTP request
    ▼
SinepilStream server (Node.js / Express)
    │
    ├─ scraper.js ──► lk21official.cc  (HTML scraping)
    ├─ scraper.js ──► gudangvape.com   (search API)
    └─ server.js  ──► playeriframe.sbs (player resolution)
                  └─► abysscdn.com / emturbovid.com (video players)
```

All scraping happens **server-side**. The browser never talks to lk21 directly — it only talks to our server, which fetches and transforms the source content on the fly.

---

## 1. Browse & Listing Scraping

### What we do

When a user opens the app or applies a filter (genre, year, country), our server calls:

```
GET https://tv10.lk21official.cc/
GET https://tv10.lk21official.cc/genre/action/
GET https://tv10.lk21official.cc/year/2024/
```

The HTML response is parsed with **Cheerio** (a server-side jQuery). Each `<article>` element on the page represents one title. We extract:

| Field | HTML source |
|-------|------------|
| `slug` | `<a itemprop="url">` href |
| `title` | `<img>` alt or title attribute |
| `poster` | `<img>` src |
| `rating` | `<span itemprop="ratingValue">` |
| `year` | `<span class="year">` |
| `genre` | `<meta itemprop="genre">` |

### Series filtering

lk21 mixes movies and TV series in the same listing. We filter series out using four signals in priority order:

1. **Anchor title attribute** — the site itself labels each entry as `"Nonton series …"` or `"Nonton movie …"` in the `<a title>` attribute. Most reliable signal.
2. **Episode badge** — series cards have `<span class="episode">` (e.g. "EPS 7"). Movies never do.
3. **Series host in href** — some series links point directly to `nontondrama`, `drakorindo`, `myasian`, etc.
4. **Slug keywords** — slugs containing `season`, `episode`, `s01e01`, etc. are skipped.

### SQLite index

Scraped listings are stored in a **SQLite database** (`data/movies.db`) using `better-sqlite3` in WAL mode. Each upsert refreshes the `indexed_at` timestamp. Movies not seen in any scrape for **60 days** are deleted automatically — this means removed content disappears from our index naturally.

```sql
CREATE TABLE movies (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  poster     TEXT,
  rating     TEXT,
  year       TEXT,
  genre      TEXT,
  indexed_at INTEGER  -- unix timestamp, refreshed on every scrape
);
```

---

## 2. Search

Search uses **two strategies in order**:

### Strategy 1: Source search API

lk21's own search bar uses a third-party API at `gudangvape.com/search.php`. We call the same endpoint directly:

```
GET https://gudangvape.com/search.php?s=inception+2010
```

Response is JSON:
```json
{
  "data": [
    {
      "slug": "inception-2010",
      "title": "Inception (2010)",
      "type": "movie",
      "year": 2010,
      "rating": 8.8,
      "poster": "2015/06/film-inception-2010.jpg"
    }
  ]
}
```

We filter to `type === 'movie'` only, reconstruct the full poster URL by prepending `https://static-jpg.lk21.party/wp-content/uploads/`, and return the results. Matching movies are also upserted into SQLite.

### Strategy 2: SQLite LIKE fallback

If the search API is unreachable, we fall back to a case-insensitive `LIKE` query across our local index:

```sql
SELECT * FROM movies
WHERE title LIKE '%inception%'
   OR replace(slug, '-', ' ') LIKE '%inception%'
ORDER BY CAST(year AS INTEGER) DESC
LIMIT 60
```

---

## 3. Movie Detail Scraping

When a user opens a movie card, `getMovie(slug)` is called:

```
GET https://tv10.lk21official.cc/inception-2010/
```

### Metadata extraction

Movie metadata is read from **JSON-LD structured data** embedded in `<script type="application/ld+json">` blocks. lk21 uses the `Movie` schema type, which contains:

```json
{
  "@type": "Movie",
  "name": "Inception",
  "datePublished": "2010",
  "duration": "PT2H28M",
  "genre": ["Action", "Sci-Fi"],
  "aggregateRating": { "ratingValue": "8.8" },
  "director": [{ "name": "Christopher Nolan" }],
  "actor": [{ "name": "Leonardo DiCaprio" }, ...]
}
```

JSON-LD is preferred over scraping raw HTML because it is machine-readable by design — it is the structured data the site publishes for Google's benefit, which makes it the most stable and reliable signal we can use.

### Series guard (movie detail level)

Even after listing-level filtering, a slug might resolve to a series page. Three checks are run in order:

1. **HTTP redirect to different host** — series pages redirect to `nontondrama.my` or similar. If the final URL hostname differs from our base host, it's a series.
2. **JS redirect page DOM markers** — lk21 shows a countdown page (`"Anda akan dialihkan dalam 5 detik"`) with unique elements `#openNow` and `main.card` for series. Movies never have these.
3. **JSON-LD `@type: TVSeries`** — if the page's schema type is `TVSeries`, we reject it.

If any check fires, the slug is deleted from the DB and `{ isSeries: true }` is returned to the frontend.

### Player resolution

lk21 lists video sources as `playeriframe.sbs` wrapper URLs:

```html
<li><a data-url="https://playeriframe.sbs/?v=abc123" data-server="CAST">CAST</a></li>
<li><a data-url="https://playeriframe.sbs/?v=def456" data-server="HYDRAX">HYDRAX</a></li>
```

Our server fetches each wrapper URL and extracts the real inner player `<iframe src>`:

```
GET https://playeriframe.sbs/?v=abc123
  └─ inner iframe src → https://short.icu/DcgcrcMTE
       └─ follows redirects → https://abysscdn.com/?v=DcgcrcMTE  (HYDRAX)
```

All players are resolved **in parallel** during the `getMovie()` call so switching player tabs is instant for the user.

Players that can't be resolved, or that are behind Cloudflare JS challenges that block server-side requests (e.g. P2P at `cloud.hownetwork.xyz`), are silently dropped from the list.

---

## 4. How We Bypass Anti-Scraping

lk21 does not aggressively block scrapers, but it does have several passive defences. Here is how each is handled.

### 4.1 User-Agent check

**Problem:** Many servers reject requests with bot-like `User-Agent` strings (e.g. `python-requests/2.28`, `axios/1.0`).

**Fix:** We send a full, realistic browser `User-Agent`:

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
```

Combined with matching `Accept`, `Accept-Language`, and `Accept-Encoding` headers, our requests look identical to a real Chrome browser on macOS.

### 4.2 Referer / Origin checks (player layer)

**Problem:** `playeriframe.sbs` and the video player backends check that requests arrive from the correct referring page. A request with no `Referer` or a wrong one is rejected with 403.

**Fix:** We set headers to mimic what a real browser visiting lk21 would send:

```js
// For playeriframe.sbs requests
headers: {
  Referer: 'https://tv10.lk21official.cc/',
  Origin:  'https://tv10.lk21official.cc',
}

// For inner player resolution
headers: {
  Referer: 'https://playeriframe.sbs/',
  Origin:  'https://playeriframe.sbs',
}
```

### 4.3 CORS block on the player's internal API

**Problem:** The P2P video player (`cloud.hownetwork.xyz`) makes an XHR POST to `api2.php` to fetch the video stream URL. This call checks a `d=` parameter that must equal the originating domain. When run in a browser, CORS prevents us from proxying this directly from the frontend.

**Fix (two parts):**

**Server-side** — we expose `/api/p2p-api` that forwards the call from our server (no CORS restriction server-to-server):

```js
app.post('/api/p2p-api', async (req, res) => {
  await axios.post(
    `https://cloud.hownetwork.xyz/api2.php?id=${id}`,
    `r=${encodeURIComponent(lk21Origin)}&d=tv10.lk21official.cc`,
    { headers: { Referer: `https://cloud.hownetwork.xyz/video.php?id=${id}` } }
  );
});
```

**Client-side (injected script)** — for proxied player pages, we inject a script before any page code runs that intercepts every XHR call to `api2.php` and reroutes it to our `/api/p2p-api`:

```js
XMLHttpRequest.prototype.open = function(method, url, async) {
  if (url.includes('api2.php')) {
    const m = url.match(/[?&]id=([^&]+)/);
    url = '/api/p2p-api' + (m ? '?id=' + m[1] : '');
  }
  _originalOpen.call(this, method, url, async !== false);
};
```

### 4.4 `document.referrer` verification

**Problem:** Some player scripts read `document.referrer` in JavaScript to verify the page was navigated to from lk21. When we proxy the player, `document.referrer` would be our domain — causing the player to reject the request.

**Fix:** We inject a property override into proxied pages before any other script runs:

```js
Object.defineProperty(document, 'referrer', {
  get: function() { return 'https://tv10.lk21official.cc/'; },
  configurable: true
});
```

### 4.5 Homepage redirect for unknown slugs (HTTP 200 trap)

**Problem:** lk21 returns **HTTP 200** for nonexistent movie slugs — it silently redirects to the homepage rather than returning 404. A naive scraper would incorrectly treat the homepage as a valid movie page.

**Fix:** When probing a slug, we check the `og:type` meta tag. Movie pages return `video.movie`; the homepage returns `website`. We also fall back to checking if the title text matches the generic homepage title pattern.

```js
const ogType = $('meta[property="og:type"]').attr('content') || '';
if (ogType === 'website') return null; // homepage redirect, not a real movie
```

### 4.6 Cloudflare JS challenge (player backends)

**Problem:** Some player backends (`cloud.hownetwork.xyz` for P2P, `abysscdn.com` for HYDRAX) are protected by Cloudflare's JavaScript challenge. The challenge requires executing browser-specific JS, solving a proof-of-work puzzle, and setting cookies — none of which our Node.js server can do.

**Consequence:** These players cannot be fetched and proxied server-side. Any attempt returns either the Cloudflare challenge HTML or a 403.

**Handling:** P2P is dropped from the player list entirely. HYDRAX and CAST are embedded as direct `<iframe>` elements in the user's real browser, which can solve the Cloudflare challenge natively.

### 4.7 Hostname verification in player JS

**Problem:** Players like HYDRAX check `window.location.hostname` against an allowlist at runtime. When a player is proxied through our server and served from our domain, `window.location.hostname` is our domain — causing the player to reject playback.

**Consequence:** Same as 4.6 — these players cannot be proxied.

**Handling:** Direct browser embedding, where `window.location.hostname` is the player's own domain.

---

## 5. What We Cannot Bypass

| Barrier | Reason |
|---------|--------|
| Cloudflare JS challenge on player backends | Requires a real browser to solve |
| Hostname verification in player JS | `window.location` is accurate when directly embedded |
| Cross-origin ad script injection | Browser security model prevents it; only browser extensions can cross origins |
| Rate limiting / IP bans | Not currently encountered; gentle scraping pace (300ms between seed requests) helps |

---

## 6. Data Flow Summary

```
User clicks movie card
        │
        ▼
GET /api/movie/:slug
        │
        ├─ fetch lk21official.cc/:slug/         ← browser UA + correct headers
        ├─ parse JSON-LD for metadata            ← structured data, stable
        ├─ check series signals (3 layers)       ← redirect / DOM / schema type
        ├─ extract playeriframe.sbs URLs         ← from #player-list anchors
        ├─ fetch each playeriframe.sbs URL       ← correct Referer spoofed
        │    └─ extract inner player iframe src
        ├─ drop P2P (Cloudflare blocked)
        └─ return { title, poster, players, … }
                │
                ▼
        Browser renders modal
                │
                ├─ CAST / HYDRAX / TURBOVIP → direct <iframe> (browser solves CF)
                └─ unresolvable → proxied through /api/proxy with injected script
```
