const lk21 = require('./sources/lk21');
const nontondrama = require('./sources/nontondrama');
const { cached, invalidate } = require('./cache');

// Slug validation for any user-supplied slug before hitting a source site.
// Rejects path traversal, schemes, query strings, whitespace, etc.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/i;
function isSafeSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

// Cache TTLs (seconds). Detail pages are slow to refresh (new subs added,
// rating nudged) — 30 min is a good compromise between freshness and load.
// Browse pages rotate more (new releases) but users tolerate slight staleness.
const TTL = {
  movie:         30 * 60,   // 30 min
  series:        30 * 60,   // 30 min
  episode:       10 * 60,   // 10 min — player URLs can rotate
  browseMovies:  10 * 60,
  browseSeries:  10 * 60,
};

async function getMovie(slug) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return cached(`movie:${slug}`, TTL.movie, () => lk21.getMovie(slug));
}

async function getSeries(slug) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return cached(`series:${slug}`, TTL.series, () => nontondrama.getSeries(slug));
}

async function getEpisode(slug, season, episode) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  return cached(
    `episode:${slug}:${s}:${e}`,
    TTL.episode,
    () => nontondrama.getEpisode(slug, s, e),
  );
}

async function browse(path = '') {
  return cached(
    `browse:movies:${path}`,
    TTL.browseMovies,
    () => lk21.browse(path),
    { staleWhileRevalidate: true },
  );
}

async function browseSeries(path = '') {
  return cached(
    `browse:series:${path}`,
    TTL.browseSeries,
    () => nontondrama.browse(path),
    { staleWhileRevalidate: true },
  );
}

// Unified search. `kind`: 'all' | 'movie' | 'series'
async function search(query, kind = 'all') {
  const q = (query || '').trim();
  if (!q) return [];

  if (kind === 'movie')  return lk21.search(q);
  if (kind === 'series') return nontondrama.search(q);

  // Parallel — both sources independent
  const [movies, series] = await Promise.all([lk21.search(q), nontondrama.search(q)]);
  return [...movies, ...series];
}

// Recognise a source URL from either site. Returns a structured result the
// server/frontend can route on.
function fromSourceUrl(url) {
  const movieSlug = lk21.slugFromSourceUrl(url);
  if (movieSlug) return { kind: 'movie', slug: movieSlug };

  const series = nontondrama.parseSourceUrl(url);
  if (series) return { kind: 'series', ...series };

  return null;
}

// Legacy name kept for backwards compat
function slugFromSourceUrl(url) {
  return lk21.slugFromSourceUrl(url);
}

// Kick off background seeding. Deferred so the server can boot first.
function startSeeding() {
  setTimeout(() => lk21.seedIndex()
    .then(() => nontondrama.seedIndex())
    .catch(() => {}), 2000);
}

module.exports = {
  getMovie, getSeries, getEpisode,
  browse, browseSeries,
  search,
  slugFromSourceUrl, fromSourceUrl,
  isSafeSlug,
  startSeeding,
  invalidateCache: invalidate,
};
