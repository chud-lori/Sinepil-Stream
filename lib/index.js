const lk21 = require('./sources/lk21');
const nontondrama = require('./sources/nontondrama');

// Slug validation for any user-supplied slug before hitting a source site.
// Rejects path traversal, schemes, query strings, whitespace, etc.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/i;
function isSafeSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

async function getMovie(slug) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return lk21.getMovie(slug);
}

async function getSeries(slug) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return nontondrama.getSeries(slug);
}

async function getEpisode(slug, season, episode) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return nontondrama.getEpisode(slug, season, episode);
}

async function browse(path = '') {
  return lk21.browse(path);
}

async function browseSeries(path = '') {
  return nontondrama.browse(path);
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
  slugFromSourceUrl,
  isSafeSlug,
  startSeeding,
};
