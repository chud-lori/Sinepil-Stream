const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'movies.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS series (
    slug           TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    poster         TEXT DEFAULT '',
    rating         TEXT DEFAULT '',
    year           TEXT DEFAULT '',
    genre          TEXT DEFAULT '',
    total_seasons  INTEGER DEFAULT 0,
    total_episodes INTEGER DEFAULT 0,
    indexed_at     INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_series_title ON series(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_series_year  ON series(year);
`);

try { db.exec(`ALTER TABLE movies ADD COLUMN rating_fetched_at INTEGER DEFAULT 0`); } catch (_) {}

const movieStmts = {
  upsert: db.prepare(`
    INSERT INTO movies (slug, title, poster, rating, year, genre, indexed_at)
    VALUES (@slug, @title, @poster, @rating, @year, @genre, strftime('%s','now'))
    ON CONFLICT(slug) DO UPDATE SET
      title      = excluded.title,
      poster     = excluded.poster,
      rating     = CASE WHEN excluded.rating != '' THEN excluded.rating ELSE movies.rating END,
      year       = excluded.year,
      genre      = excluded.genre,
      indexed_at = excluded.indexed_at
  `),
  setRating: db.prepare(`
    UPDATE movies SET rating = @rating, rating_fetched_at = strftime('%s','now') WHERE slug = @slug
  `),
  getCachedRatings: db.prepare(`
    SELECT slug, rating, rating_fetched_at FROM movies WHERE slug IN (SELECT value FROM json_each(?))
  `),
  delete: db.prepare('DELETE FROM movies WHERE slug = ?'),
  searchLike: db.prepare(`
    SELECT * FROM movies
    WHERE title LIKE ? OR replace(slug,'-',' ') LIKE ?
    ORDER BY CAST(year AS INTEGER) DESC
    LIMIT 60
  `),
  cleanStale: db.prepare(`DELETE FROM movies WHERE indexed_at < strftime('%s','now') - @ttl`),
};

const seriesStmts = {
  upsert: db.prepare(`
    INSERT INTO series (slug, title, poster, rating, year, genre, total_seasons, total_episodes, indexed_at)
    VALUES (@slug, @title, @poster, @rating, @year, @genre, @total_seasons, @total_episodes, strftime('%s','now'))
    ON CONFLICT(slug) DO UPDATE SET
      title          = excluded.title,
      poster         = excluded.poster,
      rating         = CASE WHEN excluded.rating != '' THEN excluded.rating ELSE series.rating END,
      year           = excluded.year,
      genre          = excluded.genre,
      total_seasons  = CASE WHEN excluded.total_seasons  > 0 THEN excluded.total_seasons  ELSE series.total_seasons  END,
      total_episodes = CASE WHEN excluded.total_episodes > 0 THEN excluded.total_episodes ELSE series.total_episodes END,
      indexed_at     = excluded.indexed_at
  `),
  delete: db.prepare('DELETE FROM series WHERE slug = ?'),
  searchLike: db.prepare(`
    SELECT * FROM series
    WHERE title LIKE ? OR replace(slug,'-',' ') LIKE ?
    ORDER BY CAST(year AS INTEGER) DESC
    LIMIT 60
  `),
  cleanStale: db.prepare(`DELETE FROM series WHERE indexed_at < strftime('%s','now') - @ttl`),
};

// Transactional batch upserts
const indexMovies = db.transaction((movies) => {
  for (const m of movies) {
    if (!m.slug || !m.title) continue;
    movieStmts.upsert.run({
      slug: m.slug, title: m.title,
      poster: m.poster || '', rating: m.rating || '',
      year: m.year || '', genre: m.genre || '',
    });
  }
});

const indexSeries = db.transaction((list) => {
  for (const s of list) {
    if (!s.slug || !s.title) continue;
    seriesStmts.upsert.run({
      slug: s.slug, title: s.title,
      poster: s.poster || '', rating: s.rating || '',
      year: s.year || '', genre: s.genre || '',
      total_seasons: s.total_seasons || 0,
      total_episodes: s.total_episodes || 0,
    });
  }
});

const STALE_DAYS = 60;
function runStaleCleanup() {
  const ttl = STALE_DAYS * 86400;
  const m = movieStmts.cleanStale.run({ ttl }).changes;
  const s = seriesStmts.cleanStale.run({ ttl }).changes;
  if (m > 0) console.log(`[cleanup] Removed ${m} stale movies (not seen in ${STALE_DAYS}d)`);
  if (s > 0) console.log(`[cleanup] Removed ${s} stale series (not seen in ${STALE_DAYS}d)`);
}
runStaleCleanup();
setInterval(runStaleCleanup, 24 * 60 * 60 * 1000).unref();

module.exports = { db, movieStmts, seriesStmts, indexMovies, indexSeries };
