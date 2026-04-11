const axios    = require('axios');
const cheerio  = require('cheerio');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const BASE = 'http://tv10.lk21official.cc';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
};

const PLAYER_HEADERS = {
  ...HEADERS,
  Referer: 'https://tv10.lk21official.cc/',
  Origin:  'https://tv10.lk21official.cc',
};

// Domains whose CSP frame-ancestors block embedding from localhost.
// For these we route through /api/proxy. Everything else is loaded directly.
const PROXY_DOMAINS = /cloud\.hownetwork\.xyz/i;

// Slug / itemtype patterns that reliably indicate a TV series rather than a movie.
const SERIES_SLUG_RE  = /\b(season|episode|eps|ep-?\d+|s\d{1,2}e\d{1,2})\b/i;
const SERIES_TYPE_RE  = /tvseries|tv_show|tvshow/i;
// Hostname of the series site lk21 redirects to
const SERIES_HOST_RE  = /nontondrama|drakor|myasian|dramaqu/i;


/* ---- SQLite movie index ---- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'movies.db'));
db.pragma('journal_mode = WAL');  // better concurrent read performance

db.exec(`
  CREATE TABLE IF NOT EXISTS movies (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    poster     TEXT DEFAULT '',
    rating     TEXT DEFAULT '',
    year       TEXT DEFAULT '',
    genre      TEXT DEFAULT '',
    indexed_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_movies_title ON movies(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_movies_year  ON movies(year);
`);

const _upsert = db.prepare(`
  INSERT INTO movies (slug, title, poster, rating, year, genre, indexed_at)
  VALUES (@slug, @title, @poster, @rating, @year, @genre, strftime('%s','now'))
  ON CONFLICT(slug) DO UPDATE SET
    title      = excluded.title,
    poster     = excluded.poster,
    rating     = excluded.rating,
    year       = excluded.year,
    genre      = excluded.genre,
    indexed_at = excluded.indexed_at
`);

const _delete     = db.prepare('DELETE FROM movies WHERE slug = ?');
const _searchLike = db.prepare(`
  SELECT * FROM movies
  WHERE title LIKE ? OR replace(slug,'-',' ') LIKE ?
  ORDER BY CAST(year AS INTEGER) DESC
  LIMIT 60
`);
const _all = db.prepare('SELECT * FROM movies ORDER BY indexed_at DESC');

// Remove movies whose indexed_at hasn't been refreshed in STALE_DAYS.
// A movie stops being refreshed when it no longer appears in any browse/search
// result — i.e. it was removed from the source site.
const STALE_DAYS = 60;
const _cleanStale = db.prepare(
  `DELETE FROM movies WHERE indexed_at < strftime('%s','now') - @ttl`
);
function runStaleCleanup() {
  const { changes } = _cleanStale.run({ ttl: STALE_DAYS * 86400 });
  if (changes > 0) console.log(`[cleanup] Removed ${changes} stale movies (not seen in ${STALE_DAYS} days)`);
}
// Run once at startup, then every 24 h
runStaleCleanup();
setInterval(runStaleCleanup, 24 * 60 * 60 * 1000).unref();

// Batch upsert wrapped in a transaction for speed
const indexMovies = db.transaction((movies) => {
  for (const m of movies) {
    if (!m.slug || !m.title) continue;
    _upsert.run({
      slug:   m.slug,
      title:  m.title,
      poster: m.poster  || '',
      rating: m.rating  || '',
      year:   m.year    || '',
      genre:  m.genre   || '',
    });
  }
});

async function get(url) {
  const res = await axios.get(url, {
    headers: HEADERS,
    timeout: 20000,
    maxRedirects: 5,
  });
  return cheerio.load(res.data);
}

// Parse JSON-LD schema blocks from page
function parseJsonLd($) {
  let result = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const d = JSON.parse($(el).html().trim());
      if (['Movie', 'TVSeries', 'VideoObject'].includes(d['@type'])) {
        result = { ...result, ...d };
      }
    } catch (_) {}
  });
  return result;
}

// Extract movie listing cards from article elements (series are excluded)
function extractCards($) {
  const movies = [];

  $('article').each((_, el) => {
    const $el = $(el);

    const linkEl = $el.find('a[itemprop="url"]').first();
    const href      = linkEl.attr('href') || '';
    const titleAttr = (linkEl.attr('title') || '').toLowerCase();
    if (!href) return;

    // Primary: the site itself labels entries as "Nonton series …" or "Nonton movie …"
    // in the anchor title attribute — the most reliable signal on this site.
    if (titleAttr.includes('nonton series')) return;

    // Secondary: series cards have a <span class="episode"> badge (e.g. "EPS 7")
    if ($el.find('span.episode').length > 0) return;

    // Skip cards whose link already points directly to a series host
    if (SERIES_HOST_RE.test(href)) return;

    const slug = href.replace(/^\//, '').replace(/\/$/, '');
    if (!slug) return;

    // Tertiary: slugs that explicitly contain episode/season keywords
    if (SERIES_SLUG_RE.test(slug)) return;

    const imgEl = $el.find('img[itemprop="image"], img').first();
    let title = imgEl.attr('alt') || imgEl.attr('title') || '';
    title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    if (!title) return;

    const poster = imgEl.attr('src') ||
                   $el.find('source[type="image/jpeg"]').first().attr('srcset') || '';
    const rating = $el.find('span[itemprop="ratingValue"]').first().text().trim();
    const year   = $el.find('span.year, span[itemprop="datePublished"]').first().text().trim();
    const genre  = $el.find('meta[itemprop="genre"]').attr('content') || '';

    movies.push({ title, slug, poster, rating, year, genre });
  });

  return movies;
}

// Resolve a single playeriframe.sbs URL → inner video player URL.
// Returns null on failure.
async function resolvePlayer(playerframeUrl) {
  try {
    const res = await axios.get(playerframeUrl, {
      headers: PLAYER_HEADERS,
      timeout: 8000,
      maxRedirects: 3,
    });
    const $ = cheerio.load(res.data);

    // Find the inner player iframe (skip 1×1 Cloudflare challenge iframes)
    let innerUrl = '';
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || '';
      const h   = parseInt($(el).attr('height') || '200', 10);
      const w   = parseInt($(el).attr('width')  || '200', 10);
      if (src && h > 1 && w > 1) { innerUrl = src; return false; }
    });
    if (!innerUrl) {
      innerUrl = $('.embed-container iframe').first().attr('src') || '';
    }
    return innerUrl || null;
  } catch {
    return null;
  }
}

// ---- Public API ----

async function getMovie(slug) {
  const url = `${BASE}/${slug}/`;

  // Fetch directly (not via helper) so we can inspect the final URL after redirects
  let res;
  try {
    res = await axios.get(url, {
      headers: HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });
  } catch (e) {
    if (e.response?.status === 404) {
      // Movie was removed from source — purge from DB immediately
      _delete.run(slug);
      const err = new Error('Movie not found on source site');
      err.status = 404;
      throw err;
    }
    throw e;
  }

  const $ = cheerio.load(res.data);

  // 1. HTTP redirect landed on a different host (e.g. nontondrama.my)
  const finalUrl  = res.request?.res?.responseUrl || url;
  const finalHost = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
  const baseHost  = (() => { try { return new URL(BASE).hostname;     } catch { return ''; } })();
  if (finalHost && baseHost && finalHost !== baseHost) {
    _delete.run(slug);
    return { isSeries: true, slug };
  }

  // 2. JS countdown redirect page — identified by the unique #openNow button or
  //    main.card wrapper. Every movie page has neither; every series redirect page has both.
  if ($('#openNow').length > 0 || $('main.card').length > 0) {
    _delete.run(slug);
    return { isSeries: true, slug };
  }

  const ld = parseJsonLd($);

  // 3. JSON-LD type is TVSeries
  if (ld['@type'] === 'TVSeries') {
    _delete.run(slug);
    return { isSeries: true, slug, title: ld.name || slug };
  }

  // Title
  let title = ld.name ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() || slug;
  title = title
    .replace(/^Lk21\s+Nonton\s+/i, '')
    .replace(/\s+Sub Indo.*$/i, '')
    .replace(/\s*\|\s*Streaming.*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim();

  const poster      = ld.image?.url || ld.image || $('meta[property="og:image"]').attr('content') || '';
  const description = ld.description || $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
  const genre       = Array.isArray(ld.genre) ? ld.genre.join(', ') : (ld.genre || '');
  const year        = String(ld.datePublished || '').slice(0, 4) || '';
  const rating      = String(ld.aggregateRating?.ratingValue || '');
  const duration    = ld.duration || '';
  const director    = Array.isArray(ld.director) ? ld.director.map(d => d.name).join(', ') : (ld.director?.name || '');
  const cast        = (ld.actor || []).slice(0, 8).map(a => a.name).join(', ');

  // Extract player list exactly as shown on the page (preserving website's order)
  const rawPlayers = [];
  $('#player-list li a, .player-options #player-list li a').each((_, el) => {
    const src   = $(el).attr('data-url') || $(el).attr('href') || '';
    const label = $(el).attr('data-server') || $(el).text().trim() || 'Player';
    if (src && src.includes('playeriframe')) {
      rawPlayers.push({ label: label.toUpperCase(), src });
    }
  });

  // Fallback: select options
  if (rawPlayers.length === 0) {
    $('#player-select option, .player-options select option').each((_, el) => {
      const src    = $(el).attr('value') || '';
      const server = $(el).attr('data-server') || $(el).text().replace(/GANTI PLAYER\s*/i, '').trim();
      if (src && src.includes('playeriframe')) {
        rawPlayers.push({ label: server.toUpperCase(), src });
      }
    });
  }

  // Final fallback: iframe in main-player div
  if (rawPlayers.length === 0) {
    const src = $('#main-player iframe, .main-player iframe').first().attr('src') || '';
    if (src) rawPlayers.push({ label: 'Player', src });
  }

  // Resolve all players in parallel (fetch playeriframe.sbs wrapper, get inner URL).
  // This happens during the movie API call so clicking a tab is instant.
  const resolved = await Promise.allSettled(
    rawPlayers.map(p => resolvePlayer(p.src))
  );

  const players = rawPlayers.map((p, i) => {
    const innerUrl = resolved[i].status === 'fulfilled' ? resolved[i].value : null;
    let playerUrl;

    if (!innerUrl) {
      // Couldn't resolve — proxy the wrapper directly
      playerUrl = `/api/proxy?url=${encodeURIComponent(p.src)}`;
      return { ...p, finalUrl: playerUrl, proxied: true };
    }

    if (PROXY_DOMAINS.test(innerUrl)) {
      // Domain needs proxy (has frame-ancestors CSP)
      playerUrl = `/api/proxy?url=${encodeURIComponent(innerUrl)}`;
      return { ...p, finalUrl: playerUrl, proxied: true, innerUrl };
    }

    // All good — embed directly
    return { ...p, finalUrl: innerUrl, proxied: false, innerUrl };
  });

  return {
    slug, title, poster, description, genre, year, rating, duration,
    director, cast, players, url,
  };
}

// Lightweight seed: only homepage + 4 recent years (page 1).
// Full genre/year coverage is loaded lazily as users browse.
async function seedIndex() {
  const thisYear = new Date().getFullYear();
  const seedPages = [
    '',
    `year/${thisYear}`,
    `year/${thisYear - 1}`,
    `year/${thisYear - 2}`,
    `year/${thisYear - 3}`,
  ];
  for (const p of seedPages) {
    try {
      const url = p ? `${BASE}/${p}/` : BASE;
      const $   = await get(url);
      indexMovies(extractCards($));
      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM movies').get().n;
  console.log(`[index] Seed complete: ${count} movies in DB`);
}
// Kick off background seeding (non-blocking)
setTimeout(seedIndex, 2000);


const POSTER_BASE = 'https://static-jpg.lk21.party/wp-content/uploads/';

// Search via the source site's autocomplete API (gudangvape.com/search.php).
// This is the same endpoint the source site's own search bar uses.
// Filters to movies only; maps partial poster paths to full URLs.
async function searchSource(query) {
  try {
    const res = await axios.get('https://gudangvape.com/search.php', {
      params: { s: query },
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        Referer: `${BASE}/`,
        Accept: 'application/json',
      },
      timeout: 8000,
    });
    const items = Array.isArray(res.data?.data) ? res.data.data : [];
    return items
      .filter(m => m.type === 'movie' && m.slug)
      .map(m => ({
        slug:   m.slug,
        // Strip trailing " (YYYY)" from title — year is stored separately
        title:  m.title.replace(/\s*\(\d{4}\)\s*$/, '').trim(),
        poster: m.poster ? POSTER_BASE + m.poster : '',
        year:   String(m.year || ''),
        rating: String(m.rating || ''),
        genre:  '',
      }));
  } catch {
    return [];
  }
}

async function search(query) {
  const q = query.trim();
  if (!q) return [];

  // --- Strategy 1: source site search API ---
  const fromSource = await searchSource(q);
  if (fromSource.length > 0) {
    indexMovies(fromSource);
    return fromSource;
  }

  // --- Strategy 2: SQLite cache (fallback if source API is down) ---
  const titlePart = q.replace(/\b(19|20)\d{2}\b/, '').trim();
  const searchKey = (titlePart || q).toLowerCase();
  const like = `%${searchKey.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const cached = _searchLike.all(like, like);
  if (cached.length > 0) return cached;

  return [];
}

// Extract the lk21 slug from a source web URL.
// e.g. "https://tv10.lk21official.cc/the-hunt-2012/" → "the-hunt-2012"
function slugFromSourceUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    // Must be an actual lk21 domain — "lk21" must appear as a full segment,
    // not merely as a substring of another word (e.g. "notlk21.com" must be rejected).
    // Covers: tv10.lk21official.cc, lk21official.love, lk21.de, lk21.party, etc.
    if (!/(?:^|\.)lk21(?:official\.(?:cc|love)|\.(?:de|party|cc|my\.id)|official)?(?:$|\.)/i.test(hostname)) return null;
    const slug = pathname.replace(/^\/|\/$/g, '');
    return slug || null;
  } catch {
    return null;
  }
}



async function browse(path = '') {
  const url = path ? `${BASE}/${path}/`.replace(/\/\/$/, '/') : BASE;
  const $ = await get(url);
  const movies = extractCards($);
  indexMovies(movies); // add to search index as a side-effect
  return movies;
}

module.exports = { getMovie, search, browse, slugFromSourceUrl };
