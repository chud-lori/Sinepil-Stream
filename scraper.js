const axios = require('axios');
const cheerio = require('cheerio');

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

// Extract movie listing cards from article elements
function extractCards($) {
  const movies = [];

  $('article').each((_, el) => {
    const $el = $(el);

    const linkEl = $el.find('a[itemprop="url"]').first();
    const href = linkEl.attr('href') || '';
    if (!href) return;
    const slug = href.replace(/^\//, '').replace(/\/$/, '');
    if (!slug) return;

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
  const $ = await get(url);
  const ld = parseJsonLd($);

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
    let finalUrl;

    if (!innerUrl) {
      // Couldn't resolve — proxy the wrapper directly
      finalUrl = `/api/proxy?url=${encodeURIComponent(p.src)}`;
      return { ...p, finalUrl, proxied: true };
    }

    if (PROXY_DOMAINS.test(innerUrl)) {
      // Domain needs proxy (has frame-ancestors CSP)
      finalUrl = `/api/proxy?url=${encodeURIComponent(innerUrl)}`;
      return { ...p, finalUrl, proxied: true, innerUrl };
    }

    // All good — embed directly
    return { ...p, finalUrl: innerUrl, proxied: false, innerUrl };
  });

  return {
    slug, title, poster, description, genre, year, rating, duration,
    director, cast, players, url,
  };
}

// ---- In-memory movie index ----
// Grows as pages are browsed. Persists for the server lifetime.
const movieIndex = new Map(); // slug → movie object

function indexMovies(movies) {
  for (const m of movies) {
    if (m.slug) movieIndex.set(m.slug, m);
  }
}

// Seed index in background when server starts
async function seedIndex() {
  const thisYear = new Date().getFullYear();
  const genres = [
    'action', 'drama', 'horror', 'comedy', 'thriller',
    'romance', 'animation', 'science-fiction', 'crime', 'adventure',
    'mystery', 'fantasy',
  ];
  const years = Array.from({ length: 12 }, (_, i) => thisYear - i); // last 12 years

  // Pages to seed: homepage + all genres + recent years (page 1+2 each)
  const seedPages = [
    '',
    ...genres.map(g => `genre/${g}`),
    ...years.flatMap(y => [`year/${y}`, `year/${y}/page/2`]),
  ];

  for (const p of seedPages) {
    try {
      const url = p ? `${BASE}/${p}/` : BASE;
      const $   = await get(url);
      indexMovies(extractCards($));
      await new Promise(r => setTimeout(r, 200)); // gentle pacing
    } catch {}
  }
  console.log(`[index] Seed complete: ${movieIndex.size} movies indexed`);
}
// Kick off background seeding (non-blocking)
setTimeout(seedIndex, 2000);

async function search(query) {
  const q = query.toLowerCase().trim();

  // Extract year hint from query (e.g. "batman 2012" → year=2012)
  const yearMatch = q.match(/\b(19|20)\d{2}\b/);
  const yearHint  = yearMatch ? yearMatch[0] : null;
  const qNoYear   = q.replace(/\b(19|20)\d{2}\b/, '').trim();

  // Pages to fetch on top of the index:
  // 1. Genre pages matching keyword hints
  const genreMap = {
    action: /action|fight|war|battle|superhero/i,
    horror: /horror|scary|ghost|zombie/i,
    comedy: /comedy|funny|humor/i,
    drama:  /drama|romance|love|family/i,
    animation: /animat|cartoon/i,
    thriller: /thriller|suspense|spy/i,
    'science-fiction': /sci.fi|space|robot|future/i,
    crime: /crime|murder|detective|heist/i,
  };

  const liveFetches = [];

  for (const [genre, re] of Object.entries(genreMap)) {
    if (re.test(qNoYear || q)) liveFetches.push(`genre/${genre}`);
  }

  // 2. Year-specific pages (up to 3 pages deep) if year hinted
  if (yearHint) {
    liveFetches.push(`year/${yearHint}`, `year/${yearHint}/page/2`, `year/${yearHint}/page/3`);
  } else {
    // No year hint: supplement with a few years the seed might not have covered yet
    const thisYear = new Date().getFullYear();
    for (let y = thisYear; y >= thisYear - 3; y--) {
      liveFetches.push(`year/${y}`, `year/${y}/page/2`, `year/${y}/page/3`);
    }
  }

  // Fetch live pages in parallel and add to index
  await Promise.allSettled(
    liveFetches.map(async (p) => {
      try {
        const url = `${BASE}/${p}/`;
        const $   = await get(url);
        indexMovies(extractCards($));
      } catch {}
    })
  );

  // Filter the full index
  const all = [...movieIndex.values()];
  const slugQ = (qNoYear || q).replace(/\s+/g, '-');

  return all.filter(m => {
    const t = m.title.toLowerCase();
    const s = m.slug.replace(/-\d{4}$/, ''); // strip year from slug
    return (
      t.includes(qNoYear || q) ||
      t.includes(q) ||
      m.genre?.toLowerCase().includes(qNoYear || q) ||
      s.replace(/-/g, ' ').includes(qNoYear || q) ||
      s.includes(slugQ)
    );
  }).sort((a, b) => {
    // Exact title match first
    const aq = a.title.toLowerCase().startsWith(qNoYear || q) ? 0 : 1;
    const bq = b.title.toLowerCase().startsWith(qNoYear || q) ? 0 : 1;
    return aq - bq;
  });
}

async function browse(path = '') {
  const url = path ? `${BASE}/${path}/`.replace(/\/\/$/, '/') : BASE;
  const $ = await get(url);
  const movies = extractCards($);
  indexMovies(movies); // add to search index as a side-effect
  return movies;
}

module.exports = { getMovie, search, browse };
