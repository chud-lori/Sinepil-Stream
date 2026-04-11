const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'lkscrap.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    slug      TEXT    NOT NULL UNIQUE,
    title     TEXT    NOT NULL,
    poster    TEXT,
    year      TEXT,
    rating    TEXT,
    genre     TEXT,
    watched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wishlist (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    slug      TEXT    NOT NULL UNIQUE,
    title     TEXT    NOT NULL,
    poster    TEXT,
    year      TEXT,
    rating    TEXT,
    genre     TEXT,
    added_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const History = {
  all: () => db.prepare('SELECT * FROM watch_history ORDER BY watched_at DESC').all(),
  upsert: ({ slug, title, poster, year, rating, genre }) =>
    db.prepare(`
      INSERT INTO watch_history (slug, title, poster, year, rating, genre, watched_at)
      VALUES (@slug, @title, @poster, @year, @rating, @genre, CURRENT_TIMESTAMP)
      ON CONFLICT(slug) DO UPDATE SET watched_at = CURRENT_TIMESTAMP
    `).run({ slug, title, poster: poster || '', year: year || '', rating: rating || '', genre: genre || '' }),
  remove: (slug) => db.prepare('DELETE FROM watch_history WHERE slug = ?').run(slug),
  has: (slug) => !!db.prepare('SELECT 1 FROM watch_history WHERE slug = ?').get(slug),
};

const Wishlist = {
  all: () => db.prepare('SELECT * FROM wishlist ORDER BY added_at DESC').all(),
  add: ({ slug, title, poster, year, rating, genre }) =>
    db.prepare(`
      INSERT OR IGNORE INTO wishlist (slug, title, poster, year, rating, genre)
      VALUES (@slug, @title, @poster, @year, @rating, @genre)
    `).run({ slug, title, poster: poster || '', year: year || '', rating: rating || '', genre: genre || '' }),
  remove: (slug) => db.prepare('DELETE FROM wishlist WHERE slug = ?').run(slug),
  has: (slug) => !!db.prepare('SELECT 1 FROM wishlist WHERE slug = ?').get(slug),
  toggle: (movie) => {
    if (Wishlist.has(movie.slug)) {
      Wishlist.remove(movie.slug);
      return false;
    } else {
      Wishlist.add(movie);
      return true;
    }
  },
};

module.exports = { History, Wishlist };
