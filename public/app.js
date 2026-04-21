/* =====================================================================
   SinepilStream — frontend
   History & Wishlist: localStorage (per-browser, no account needed)
   Player: resolved via /api/resolve to bypass CSP frame-ancestors
   ===================================================================== */

/* ---- localStorage helpers ---- */
const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

const HISTORY_KEY  = 'spilstream_history';
const WISHLIST_KEY = 'spilstream_wishlist';

/* ---- History (localStorage) ---- */
const History = {
  all: () => LS.get(HISTORY_KEY),
  has: (slug) => LS.get(HISTORY_KEY).some(m => m.slug === slug),
  upsert: (movie) => {
    let list = LS.get(HISTORY_KEY).filter(m => m.slug !== movie.slug);
    list.unshift({ ...movie, watched_at: new Date().toISOString() });
    if (list.length > 200) list = list.slice(0, 200); // keep latest 200
    LS.set(HISTORY_KEY, list);
  },
  remove: (slug) => LS.set(HISTORY_KEY, LS.get(HISTORY_KEY).filter(m => m.slug !== slug)),
  clear:  () => LS.set(HISTORY_KEY, []),
};

/* ---- Wishlist (localStorage) ---- */
const Wishlist = {
  all: () => LS.get(WISHLIST_KEY),
  has: (slug) => LS.get(WISHLIST_KEY).some(m => m.slug === slug),
  add: (movie) => {
    if (Wishlist.has(movie.slug)) return;
    const list = LS.get(WISHLIST_KEY);
    list.unshift({ ...movie, added_at: new Date().toISOString() });
    LS.set(WISHLIST_KEY, list);
  },
  remove: (slug) => LS.set(WISHLIST_KEY, LS.get(WISHLIST_KEY).filter(m => m.slug !== slug)),
  toggle: (movie) => {
    if (Wishlist.has(movie.slug)) { Wishlist.remove(movie.slug); return false; }
    Wishlist.add(movie); return true;
  },
};

/* ---- State ---- */
let currentMovie   = null;      // Movie OR series record currently open in modal
let currentPlayers = [];
let descExpanded   = false;
let currentKind    = 'movie';   // 'movie' | 'series'
let currentSeries  = null;      // full series record (with seasons) when kind === 'series'
let currentEpisode = null;      // { season, episode } when a series episode is loaded

/* ---- Migration: older localStorage entries have no `kind` — default to movie ---- */
(function migrateKinds() {
  for (const k of [HISTORY_KEY, WISHLIST_KEY]) {
    const list = LS.get(k);
    let changed = false;
    for (const item of list) {
      if (!item.kind) { item.kind = 'movie'; changed = true; }
    }
    if (changed) LS.set(k, list);
  }
})();

/* ---- Tab switching ---- */
let activeTab = 'browse';
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('sec-' + name)?.classList.add('active');
  // 'search' has no nav-tab anymore — typing in the bar drives navigation directly.
  document.getElementById('tab-' + name)?.classList.add('active');
  document.getElementById('browse-bar').style.display = (name === 'browse') ? 'flex' : 'none';
  if (name === 'browse')   renderContinueWatching();
  if (name === 'history')  renderHistory();
  if (name === 'wishlist') renderWishlist();
  if (name === 'series' && !document.getElementById('series-grid').dataset.loaded) {
    loadGrid('series-grid', '/api/browse/series');
    document.getElementById('series-grid').dataset.loaded = '1';
  }
  updateTabChrome(name);
}

// Update placeholders/labels so the search + watch-by-url bars reflect the
// currently active tab. Purely cosmetic — search/URL endpoints themselves
// accept either kind.
function updateTabChrome(name) {
  const searchInput = document.getElementById('search-input');
  const urlInput    = document.getElementById('url-input');
  const urlLabel    = document.querySelector('.url-bar-label');

  if (name === 'series') {
    searchInput.placeholder = 'Search series…';
    urlInput.placeholder = 'Paste a nontondrama.my series or episode link to watch…';
    if (urlLabel) urlLabel.innerHTML = '&#128279; Watch series by URL:';
  } else if (name === 'browse') {
    searchInput.placeholder = 'Search movies…';
    urlInput.placeholder = 'Paste a lk21official.cc link here to watch without ads…';
    if (urlLabel) urlLabel.innerHTML = '&#128279; Watch movie by URL:';
  } else {
    // history / wishlist / search — keep generic wording
    searchInput.placeholder = 'Search movies or series…';
    urlInput.placeholder = 'Paste any lk21 movie or nontondrama series link…';
    if (urlLabel) urlLabel.innerHTML = '&#128279; Watch by URL:';
  }
}

/* ---- Browse / Filter ---- */
function applyFilter() {
  const genre   = document.getElementById('filter-genre').value;
  const country = document.getElementById('filter-country').value;
  const year    = document.getElementById('filter-year').value;
  const path    = genre || country || year || '';
  const label   = path
    ? path.split('/').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
    : 'Latest Movies';
  document.getElementById('browse-title').textContent = label;
  loadGrid('browse-grid', `/api/browse?path=${encodeURIComponent(path)}`);
}

/* ---- Search (always covers both movies + series, regardless of active tab) ---- */
async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  showTab('search');
  loadGrid('search-grid', `/api/search?q=${encodeURIComponent(q)}`, 'search-count');
}

/* ---- Watch by URL (accepts source movie URLs + source series/episode URLs) ---- */
async function watchByUrl() {
  const input = document.getElementById('url-input');
  const url = input.value.trim();
  if (!url) return;
  const res = await fetch(`/api/slug-from-url?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (res.ok && data.slug) {
    input.value = '';
    if (data.kind === 'series') {
      openSeries(data.slug, data.episode ? { autoEpisode: { season: data.season, episode: data.episode } } : {});
    } else {
      openMovie(data.slug);
    }
    return;
  }
  toast('URL not recognised — must be a lk21 movie or nontondrama series link');
}

/* ---- Skeleton card placeholder ---- */
const SKELETON_CARD = `
  <div class="card card-skeleton" aria-hidden="true">
    <div class="card-img-wrap"></div>
    <div class="card-body">
      <div class="skeleton-line"></div>
      <div class="skeleton-line skeleton-line--short"></div>
    </div>
  </div>`;

/* ---- Generic grid loader ---- */
async function loadGrid(gridId, apiUrl, badgeId) {
  const grid = document.getElementById(gridId);
  grid.innerHTML = Array(12).fill(SKELETON_CARD).join('');
  if (badgeId) document.getElementById(badgeId).textContent = '';
  try {
    const res  = await fetch(apiUrl);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (badgeId) document.getElementById(badgeId).textContent = data.length || '';
    grid.innerHTML = data.length
      ? data.map(m => cardHTML(m)).join('')
      : emptyHTML('No results found — try adding a year (e.g. "batman 2012") or browse by genre/year instead');
    attachCardEvents(grid);
  } catch (e) {
    grid.innerHTML = emptyHTML('Failed to load: ' + e.message);
  }
}

/* ---- History rendering ---- */
function renderHistory() {
  const grid = document.getElementById('history-grid');
  const data  = History.all();
  grid.innerHTML = data.length
    ? data.map(m => cardHTML(m, { showDelete: true, ctx: 'history' })).join('')
    : emptyHTML('No watch history yet');
  attachCardEvents(grid, 'history');
}

/* ---- Continue Watching rail ---- */
const CONTINUE_WATCHING_MAX = 12;
function renderContinueWatching() {
  const wrap = document.getElementById('continue-watching');
  const grid = document.getElementById('continue-watching-grid');
  if (!wrap || !grid) return;
  const items = History.all().slice(0, CONTINUE_WATCHING_MAX);
  if (items.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  // `hideWatchedBadge` — every card here is watched by definition, the tick
  // on every one would be visual noise.
  grid.innerHTML = items.map(m => cardHTML(m, { hideWatchedBadge: true })).join('');
  attachCardEvents(grid);
}

async function clearHistory() {
  if (!confirm('Clear all watch history?')) return;
  History.clear();
  renderHistory();
  renderContinueWatching();
  toast('History cleared');
}

/* ---- Wishlist rendering ---- */
function renderWishlist() {
  const grid  = document.getElementById('wishlist-grid');
  const badge = document.getElementById('wishlist-count');
  const data  = Wishlist.all();
  badge.textContent = data.length || '';
  grid.innerHTML = data.length
    ? data.map(m => cardHTML(m, { showDelete: true, ctx: 'wishlist' })).join('')
    : emptyHTML('Your wishlist is empty');
  attachCardEvents(grid, 'wishlist');
}

/* ---- Card HTML ---- */
function cardHTML(m, opts = {}) {
  const kind = m.kind === 'series' ? 'series' : 'movie';
  const kindBadge = kind === 'series'
    ? `<span class="card-kind">${m.total_episodes ? `EPS ${m.total_episodes}` : 'SERIES'}</span>`
    : '';
  const watchedBadge = (!opts.hideWatchedBadge && History.has(m.slug))
    ? '<span class="card-watched" title="Watched">&#10003;</span>' : '';
  // load / error listeners wired up in attachCardEvents — inline event
  // handlers would violate our CSP (script-src-attr 'none').
  // Watched badge nests inside the image wrapper so it sits on the poster,
  // not under the card title block.
  const poster = m.poster
    ? `<div class="card-img-wrap">
         <img class="card-img" src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy">
         ${watchedBadge}
       </div>`
    : '';
  const placeholder = `<div class="card-img-placeholder" ${m.poster ? 'style="display:none"' : ''}>&#127916;</div>`;
  // Fallback: no poster → render badge directly on the card
  const looseBadge = !m.poster ? watchedBadge : '';
  const stars = m.rating ? `<span class="card-rating">&#9733; ${m.rating}</span>` : '';
  const year  = m.year   ? `<span class="card-year">${m.year}</span>` : '';

  let actions = '';
  if (opts.showDelete) {
    actions = `
      <div class="card-actions">
        <button class="card-btn" title="Remove"
          data-action="remove" data-ctx="${esc(opts.ctx || '')}" data-slug="${esc(m.slug)}">&#x2715;</button>
      </div>`;
  } else {
    // Use data-* attribute (HTML-safe for any character) to carry the movie JSON.
    // Embedding JSON in onclick="…" breaks for titles containing apostrophes
    // because esc() turns ' into &#x27; which the browser decodes back to ' BEFORE
    // the JS parser sees it, terminating the string literal early.
    const isWl = Wishlist.has(m.slug);
    actions = `
      <div class="card-actions">
        <button class="card-btn${isWl ? ' active' : ''}" title="Wishlist"
          data-action="wishlist" data-movie="${esc(JSON.stringify(m))}">${isWl ? '&#9829;' : '&#9825;'}</button>
      </div>`;
  }

  return `
    <div class="card" data-slug="${esc(m.slug)}" data-kind="${esc(kind)}">
      ${poster}${placeholder}
      ${kindBadge}
      ${looseBadge}
      ${actions}
      <div class="card-body">
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-meta">${stars}${year}</div>
      </div>
    </div>`;
}

function attachCardEvents(grid) {
  // Wire up load / error handlers on each freshly-rendered image and also
  // handle the cached case (load event fired before the listener attached →
  // we detect with `complete && naturalWidth`).
  grid.querySelectorAll('img.card-img').forEach(img => {
    const markLoaded = () => {
      img.classList.add('loaded');
      img.parentElement?.classList.add('loaded');
    };
    const markError = () => {
      const wrap = img.parentElement;
      if (wrap) wrap.style.display = 'none';
      wrap?.nextElementSibling?.style.setProperty('display', 'flex');
    };
    if (img.complete && img.naturalWidth > 0) markLoaded();
    else if (img.complete) markError();
    else {
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', markError, { once: true });
    }
  });

  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Action buttons inside the card carry data-action; let them handle the click
      // and DON'T open the modal in that case.
      const btn = e.target.closest('[data-action]');
      if (btn) {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'wishlist') {
          try { quickWishlist(btn, JSON.parse(btn.dataset.movie)); }
          catch (err) { console.error('wishlist parse error', err); }
        } else if (action === 'remove') {
          removeItem(btn.dataset.ctx, btn.dataset.slug);
        }
        return;
      }
      openItem(card.dataset.slug, card.dataset.kind || 'movie');
    });
  });
}

function openItem(slug, kind) {
  if (kind === 'series') return openSeries(slug);
  return openMovie(slug);
}

/* ---- Remove from history/wishlist ---- */
function removeItem(ctx, slug) {
  if (ctx === 'wishlist') { Wishlist.remove(slug); renderWishlist(); toast('Removed from wishlist'); }
  else                    { History.remove(slug);  renderHistory();  renderContinueWatching();  toast('Removed from history'); }
}

/* ---- Quick wishlist toggle from card ---- */
function quickWishlist(btn, movie) {
  // Accept either a parsed object (new code path) or a JSON string (legacy callers).
  if (typeof movie === 'string') {
    try { movie = JSON.parse(movie); } catch { return; }
  }
  if (!movie?.slug) return;
  const added = Wishlist.toggle(movie);
  btn.classList.toggle('active', added);
  // Swap outline ♡ → filled ♥ to match the convention everyone knows from
  // Twitter / Instagram / Pinterest / Apple Music.
  btn.innerHTML = added ? '&#9829;' : '&#9825;';
  toast(added ? `Added "${movie.title}" to wishlist` : 'Removed from wishlist');
}

/* ---- Reset modal to a neutral state before loading a new item ---- */
function resetModalChrome() {
  currentMovie   = null;
  currentSeries  = null;
  currentEpisode = null;
  currentPlayers = [];
  descExpanded   = false;

  document.getElementById('modal-overlay').classList.add('open');
  resetPlayer('Loading…');
  document.getElementById('player-tabs').innerHTML = '';
  const picker = document.getElementById('episode-picker');
  if (picker) picker.style.display = 'none';

  // Show skeleton shimmer in the info pane while scraper fetches upstream.
  // Title/meta/desc/cast get replaced wholesale by renderModal on success,
  // so we don't need to manage a separate teardown.
  document.getElementById('modal-title').innerHTML = '<span class="skeleton-line skeleton-line--title"></span>';
  document.getElementById('modal-meta').innerHTML  = `
    <span class="pill skeleton-pill"></span>
    <span class="pill skeleton-pill"></span>
    <span class="pill skeleton-pill"></span>`;
  document.getElementById('modal-desc').innerHTML  = `
    <span class="skeleton-line"></span>
    <span class="skeleton-line"></span>
    <span class="skeleton-line skeleton-line--short"></span>`;
  document.getElementById('modal-cast').innerHTML  = '';

  const _mp = document.getElementById('modal-poster');
  _mp.classList.remove('loaded');
  _mp.removeAttribute('src');
  document.getElementById('read-more-btn').style.display = 'none';
}

/* ---- Open series modal ---- */
async function openSeries(slug, { pushHistory = true, autoEpisode } = {}) {
  currentKind = 'series';
  if (pushHistory) {
    history.pushState({ slug, kind: 'series' }, '', '/series/' + encodeURIComponent(slug));
  }
  resetModalChrome();

  try {
    const res  = await fetch(`/api/series/${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    currentSeries = data;
    currentMovie  = { ...data, kind: 'series' };

    renderModal({ ...data, duration: '' });

    // Save to history (without episode until the user plays one)
    const existing = History.all().find(m => m.slug === data.slug);
    History.upsert({
      slug: data.slug, title: data.title, poster: data.poster,
      year: data.year, rating: data.rating, genre: data.genre,
      kind: 'series',
      lastSeason: existing?.lastSeason || 0,
      lastEpisode: existing?.lastEpisode || 0,
    });

    renderSeasonSelect(data);

    const startSeason  = autoEpisode?.season  || existing?.lastSeason  || data.seasons[0]?.season;
    const startEpisode = autoEpisode?.episode || existing?.lastEpisode || null;
    if (startSeason) {
      document.getElementById('season-select').value = String(startSeason);
      renderEpisodeList();
      if (startEpisode) loadEpisode(startSeason, startEpisode);
      else resetPlayer('Select an episode to start watching');
    } else {
      resetPlayer('No episodes available');
    }
  } catch (e) {
    document.getElementById('modal-title').textContent = 'Error loading series';
    resetPlayer('Error: ' + e.message);
  }
}

function renderSeasonSelect(data) {
  const picker = document.getElementById('episode-picker');
  picker.style.display = 'block';
  const sel = document.getElementById('season-select');
  sel.innerHTML = data.seasons.map(s =>
    `<option value="${s.season}">Season ${s.season} (${s.episodes.length} eps)</option>`
  ).join('');
}

function renderEpisodeList() {
  if (!currentSeries) return;
  const season = parseInt(document.getElementById('season-select').value, 10);
  const s = currentSeries.seasons.find(x => x.season === season);
  const list = document.getElementById('episode-list');
  if (!s) { list.innerHTML = ''; return; }
  list.innerHTML = s.episodes.map(e => {
    const active = currentEpisode?.season === s.season && currentEpisode?.episode === e.episode ? ' active' : '';
    return `<button class="episode-btn${active}"
      data-action="loadEpisode"
      data-season="${s.season}" data-episode="${e.episode}"
      title="${esc(e.title || `Episode ${e.episode}`)}">EP ${e.episode}</button>`;
  }).join('');
}

async function loadEpisode(season, episode) {
  if (!currentSeries) return;
  const status = document.getElementById('episode-status');
  status.textContent = `Loading S${season} E${episode}…`;
  resetPlayer('Loading…');
  document.getElementById('player-tabs').innerHTML = '';

  try {
    const res  = await fetch(`/api/episode/${encodeURIComponent(currentSeries.slug)}/${season}/${episode}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    currentEpisode = { season, episode };
    currentPlayers = sortPlayers(data.players || []);

    // Update history with resume point
    History.upsert({
      slug: currentSeries.slug, title: currentSeries.title, poster: currentSeries.poster,
      year: currentSeries.year, rating: currentSeries.rating, genre: currentSeries.genre,
      kind: 'series', lastSeason: season, lastEpisode: episode,
    });

    renderPlayerTabs();
    renderEpisodeList();      // refresh active highlight
    renderNextEpisodeBtn();
    status.textContent = `S${season} E${episode}`;

    if (currentPlayers.length > 0) loadPlayer(0);
    else resetPlayer('No player sources found for this episode');
  } catch (e) {
    status.textContent = '';
    resetPlayer('Error: ' + e.message);
  }
}

// Find the next episode in current season, or first ep of the next season.
// Returns null when there's nothing after the current one.
function findNextEpisode() {
  if (!currentSeries || !currentEpisode) return null;
  const { season, episode } = currentEpisode;
  const seasons = currentSeries.seasons;
  const sIdx = seasons.findIndex(s => s.season === season);
  if (sIdx === -1) return null;

  const eps = seasons[sIdx].episodes;
  const eIdx = eps.findIndex(e => e.episode === episode);
  if (eIdx === -1) return null;

  if (eIdx + 1 < eps.length) {
    return { season, episode: eps[eIdx + 1].episode };
  }
  const nextSeason = seasons[sIdx + 1];
  if (nextSeason && nextSeason.episodes[0]) {
    return { season: nextSeason.season, episode: nextSeason.episodes[0].episode };
  }
  return null;
}

function renderNextEpisodeBtn() {
  const btn = document.getElementById('next-episode-btn');
  if (!btn) return;
  const next = findNextEpisode();
  if (!next) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.innerHTML = `Next &rarr; EP ${next.episode}${next.season !== currentEpisode.season ? ` (S${next.season})` : ''}`;
}

function loadNextEpisode() {
  const next = findNextEpisode();
  if (next) loadEpisode(next.season, next.episode);
}

/* ---- Shared: sort players by reliability ---- */
function sortPlayers(players) {
  const PRIORITY = ['CAST', 'HYDRAX', 'TURBOVIP'];
  return players.slice().sort((a, b) => {
    const ai = PRIORITY.indexOf((a.label || '').toUpperCase());
    const bi = PRIORITY.indexOf((b.label || '').toUpperCase());
    return (ai === -1 ? PRIORITY.length : ai) - (bi === -1 ? PRIORITY.length : bi);
  });
}

function renderPlayerTabs() {
  const tabsEl = document.getElementById('player-tabs');
  if (currentPlayers.length === 0) {
    tabsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">No player sources found.</span>';
  } else {
    tabsEl.innerHTML = currentPlayers.map((p, i) =>
      `<button class="ptab${i===0?' active':''}" data-action="loadPlayer" data-index="${i}">${esc(p.label || `Player ${i+1}`)}</button>`
    ).join('');
  }
}

/* ---- Open movie modal ---- */
async function openMovie(slug, { pushHistory = true } = {}) {
  currentKind = 'movie';
  if (pushHistory) {
    history.pushState({ slug, kind: 'movie' }, '', '/movie/' + encodeURIComponent(slug));
  }
  resetModalChrome();

  try {
    const res  = await fetch(`/api/movie/${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.isSeries) {
      // Source classified it as a series — hand off to series flow
      return openSeries(slug, { pushHistory: false });
    }

    currentMovie = data;
    currentPlayers = sortPlayers(data.players || []);

    renderModal(data);
    renderPlayerTabs();
    if (currentPlayers.length > 0) loadPlayer(0);

    History.upsert({
      slug: data.slug, title: data.title, poster: data.poster,
      year: data.year, rating: data.rating, genre: data.genre,
      kind: 'movie',
    });
  } catch (e) {
    document.getElementById('modal-title').textContent = 'Error loading movie';
    resetPlayer('Error: ' + e.message);
  }
}

function renderModal(data) {
  const posterEl = document.getElementById('modal-poster');
  // Wire handlers BEFORE setting src so we never miss a synchronous fire.
  posterEl.classList.remove('loaded');
  posterEl.onload  = () => posterEl.classList.add('loaded');
  posterEl.onerror = () => posterEl.classList.add('loaded'); // hide shimmer even on error
  const url = data.poster || '';
  if (url) {
    posterEl.src = url;
    // Edge case: setting src to a value that's already loaded (cached or
    // identical to the previous src) doesn't fire a 'load' event in any
    // browser. Detect that and mark loaded ourselves so the image becomes
    // visible instead of staying at opacity:0 forever.
    if (posterEl.complete && posterEl.naturalWidth > 0) {
      posterEl.classList.add('loaded');
    }
  } else {
    posterEl.removeAttribute('src');
    posterEl.classList.add('loaded'); // no poster → just stop the shimmer
  }

  document.getElementById('modal-title').textContent = data.title || 'Unknown';

  const meta = [];
  if (data.year)     meta.push(`<span class="pill">${data.year}</span>`);
  if (data.rating)   meta.push(`<span class="pill rating">&#9733; ${data.rating}</span>`);
  if (data.duration) meta.push(`<span class="pill">${formatDuration(data.duration)}</span>`);
  if (data.genre)    data.genre.split(',').slice(0, 3).forEach(g =>
    meta.push(`<span class="pill">${g.trim()}</span>`)
  );
  document.getElementById('modal-meta').innerHTML = meta.join('');

  const desc = data.description || '';
  document.getElementById('modal-desc').textContent = desc;
  document.getElementById('read-more-btn').style.display = desc.length > 180 ? 'inline' : 'none';

  const parts = [];
  if (data.director) parts.push(`<strong>Director:</strong> ${esc(data.director)}`);
  if (data.cast)     parts.push(`<strong>Cast:</strong> ${esc(data.cast)}`);
  document.getElementById('modal-cast').innerHTML = parts.join('<br>');

  // Show native Share button only on devices that support it (mobile)
  document.getElementById('btn-share-native').style.display = navigator.share ? '' : 'none';

  const wBtn = document.getElementById('btn-wishlist');
  const inWL = Wishlist.has(data.slug);
  wBtn.classList.toggle('added', inWL);
  wBtn.innerHTML = inWL ? '&#9829; In Wishlist' : '&#9825; Wishlist';
}

/* ---- Load player (finalUrl pre-resolved during movie scrape — instant) ---- */
let playerLoadTimer = null;

function loadPlayer(index) {
  const p = currentPlayers[index];
  if (!p) return;

  document.querySelectorAll('.ptab').forEach((t, i) => t.classList.toggle('active', i === index));

  const wrap = document.getElementById('player-wrap');

  // finalUrl is already resolved by the server at scrape time — no extra round-trip
  const playerUrl = p.finalUrl || p.src;

  if (!playerUrl) {
    wrap.innerHTML = playerErrorHTML('No URL available for this player', index);
    return;
  }

  wrap.innerHTML = `<iframe
    id="player-iframe"
    src="${esc(playerUrl)}"
    allowfullscreen
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
    referrerpolicy="no-referrer"
  ></iframe>
  <button class="player-fullscreen-btn" id="player-fullscreen-btn"
          data-action="fullscreenPlayer" title="Fullscreen" style="display:flex">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  </button>`;

  // Detect network-level load failures: if the iframe never fires `load`
  // within the timeout window, surface the "try next player" fallback.
  // (Can't detect broken embed contents cross-origin — only total failure.)
  if (playerLoadTimer) clearTimeout(playerLoadTimer);
  const iframe = document.getElementById('player-iframe');
  let loaded = false;
  iframe?.addEventListener('load', () => {
    loaded = true;
    if (playerLoadTimer) { clearTimeout(playerLoadTimer); playerLoadTimer = null; }
  }, { once: true });
  playerLoadTimer = setTimeout(() => {
    if (!loaded) {
      wrap.innerHTML = playerErrorHTML('This player is taking too long to load', index);
    }
  }, 15000);

  // Once the iframe is in place, fade the modal-close like a video control overlay.
  document.querySelector('.modal-close')?.classList.add('auto-hide');
  showFsBtn(); // show briefly when player loads, then auto-hides after 3s
}

function playerErrorHTML(msg, currentIndex) {
  const nextIndex = currentIndex + 1;
  const hasNext   = nextIndex < currentPlayers.length;
  return `<div class="player-placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="42" height="42">
      <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
    </svg>
    <span style="font-size:13px;color:#e55;max-width:360px;text-align:center">${esc(msg)}</span>
    ${hasNext
      ? `<button class="btn btn-outline" style="margin-top:10px;font-size:12px" data-action="loadPlayer" data-index="${nextIndex}">
           Try ${esc(currentPlayers[nextIndex]?.label || 'Next Player')}
         </button>`
      : '<span style="font-size:12px;color:var(--muted)">No more players available</span>'
    }
  </div>`;
}

/* ---- Current item URL path (movie vs series) ---- */
function currentItemPath() {
  if (!currentMovie) return '/';
  const base = currentKind === 'series' ? '/series/' : '/movie/';
  return base + encodeURIComponent(currentMovie.slug);
}

/* ---- Wishlist toggle (modal) ---- */
function toggleWishlist() {
  if (!currentMovie) return;
  const entry = {
    slug: currentMovie.slug, title: currentMovie.title, poster: currentMovie.poster,
    year: currentMovie.year, rating: currentMovie.rating, genre: currentMovie.genre,
    kind: currentKind,
  };
  const added = Wishlist.toggle(entry);
  const wBtn  = document.getElementById('btn-wishlist');
  wBtn.classList.toggle('added', added);
  wBtn.innerHTML = added ? '&#9829; In Wishlist' : '&#9825; Wishlist';
  toast(added ? 'Added to wishlist' : 'Removed from wishlist');
}

/* ---- Modal close ---- */
function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('open');
  document.querySelector('.modal-close')?.classList.remove('auto-hide', 'visible');
  resetPlayer();
  currentMovie   = null;
  currentSeries  = null;
  currentEpisode = null;
  currentPlayers = [];
  // Restore URL to home (only if we're currently on a /movie/ or /series/ path)
  if (/^\/(movie|series)\//.test(location.pathname)) {
    history.pushState({}, '', '/');
  }
}

/* ---- Share ---- */
function copyMovieLink() {
  if (!currentMovie) return;
  const url = location.origin + currentItemPath();
  const btn = document.getElementById('btn-copy-link');
  navigator.clipboard.writeText(url).then(() => {
    const prev = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="4 10 8 14 16 6"/>
    </svg> Copied!`;
    btn.style.cssText += 'border-color:var(--accent2);color:var(--accent2)';
    setTimeout(() => { btn.innerHTML = prev; btn.style.cssText = ''; }, 2200);
  }).catch(() => toast('Copy: ' + url));
}

function nativeShare() {
  if (!currentMovie || !navigator.share) return;
  const kindLabel = currentKind === 'series' ? 'series' : 'movie';
  navigator.share({
    title: currentMovie.title,
    text: `Watch the ${kindLabel} "${currentMovie.title}" on SinepilStream`,
    url: location.origin + currentItemPath(),
  }).catch(() => {});
}

function resetPlayer(msg) {
  if (playerLoadTimer) { clearTimeout(playerLoadTimer); playerLoadTimer = null; }
  document.getElementById('player-wrap').innerHTML = `
    <div class="player-placeholder" id="player-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
        <circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16"/>
      </svg>
      <span>${msg || 'Select a player below to start watching'}</span>
    </div>
    <button class="player-fullscreen-btn" id="player-fullscreen-btn"
            data-action="fullscreenPlayer" title="Fullscreen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
    </button>`;
}

/* ---- Fullscreen + close button idle-show/hide ---- */
let _fsIdleTimer = null;

function showFsBtn() {
  const btn   = document.getElementById('player-fullscreen-btn');
  const close = document.querySelector('.modal-close');
  if (btn && btn.style.display === 'flex') btn.classList.add('visible');
  if (close && close.classList.contains('auto-hide')) close.classList.add('visible');
  clearTimeout(_fsIdleTimer);
  _fsIdleTimer = setTimeout(() => {
    document.getElementById('player-fullscreen-btn')?.classList.remove('visible');
    document.querySelector('.modal-close')?.classList.remove('visible');
  }, 3000);
}

// Show on any user activity inside the modal (mousemove for desktop, touchstart for mobile)
const _modal = document.getElementById('modal');
_modal?.addEventListener('mousemove', showFsBtn);
_modal?.addEventListener('touchstart', showFsBtn, { passive: true });
// Show on any keypress (useful in fullscreen where mouse events are inside iframe)
document.addEventListener('keydown', showFsBtn);

/* ---- Fullscreen the player wrap (not the iframe) so our button stays visible ---- */
function fullscreenPlayer() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  const wrap = document.getElementById('player-wrap');
  if (!wrap || !wrap.querySelector('iframe')) return;
  (wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.mozRequestFullScreen)?.call(wrap);
}

// Sync button icon with fullscreen state and show button briefly on transition
function _onFullscreenChange() {
  const btn = document.getElementById('player-fullscreen-btn');
  if (!btn) return;
  const isFs = !!document.fullscreenElement;
  btn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
  btn.querySelector('svg').innerHTML = isFs
    ? '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>'
    : '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>';
  showFsBtn(); // always show briefly on fullscreen enter/exit
}
document.addEventListener('fullscreenchange', _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

/* ---- Toggle description ---- */
function toggleDesc() {
  descExpanded = !descExpanded;
  document.getElementById('modal-desc').classList.toggle('expanded', descExpanded);
  document.getElementById('read-more-btn').textContent = descExpanded ? 'Show less' : 'Read more';
}

/* ---- Toast ---- */
function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), duration);
}

/* ---- Helpers ---- */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
function emptyHTML(msg) { return `<div class="empty">${msg}</div>`; }
function formatDuration(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return iso;
  return ((m[1] ? m[1] + 'h ' : '') + (m[2] ? m[2] + 'm' : '')).trim() || iso;
}

/* ---- Keyboard ---- */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    document.getElementById('search-input').focus();
  }
});

/* ---- Browser back/forward ---- */
window.addEventListener('popstate', (e) => {
  if (e.state?.slug) {
    openItem(e.state.slug, e.state.kind || 'movie');
  } else {
    if (document.getElementById('modal-overlay').classList.contains('open')) {
      document.getElementById('modal-overlay').classList.remove('open');
      resetPlayer();
      currentMovie   = null;
      currentSeries  = null;
      currentEpisode = null;
      currentPlayers = [];
    }
  }
});

/* ---- Global event delegation ----
   All `data-action="foo"` elements dispatch here. Replaces inline
   onclick="…" handlers that our CSP (script-src-attr 'none') blocks.
   Card-internal actions (wishlist/remove) are still handled inside
   attachCardEvents because they need to stopPropagation before the card's
   own click handler fires. */
const CLICK_ACTIONS = {
  showTab:            (el) => showTab(el.dataset.arg),
  doSearch:           () => doSearch(),
  watchByUrl:         () => watchByUrl(),
  applyFilter:        () => applyFilter(),
  clearHistory:       () => clearHistory(),
  closeModal:         () => closeModal(),
  closeModalOverlay:  (el, e) => closeModal(e),
  fullscreenPlayer:   () => fullscreenPlayer(),
  toggleDesc:         () => toggleDesc(),
  toggleWishlist:     () => toggleWishlist(),
  copyMovieLink:      () => copyMovieLink(),
  nativeShare:        () => nativeShare(),
  loadPlayer:         (el) => loadPlayer(parseInt(el.dataset.index, 10)),
  loadEpisode:        (el) => loadEpisode(
    parseInt(el.dataset.season,  10),
    parseInt(el.dataset.episode, 10),
  ),
  dismissNotice:      (el) => {
    const target = document.getElementById(el.dataset.target);
    if (target) target.style.display = 'none';
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // Cards have their own listener that handles wishlist/remove inside
  // attachCardEvents — leave those alone here.
  if (el.dataset.action === 'wishlist' || el.dataset.action === 'remove') return;
  const fn = CLICK_ACTIONS[el.dataset.action];
  if (fn) fn(el, e);
});

// Filter selects + season-select all dispatch 'change' to the same registry.
document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'season-select') renderEpisodeList();
  else if (id === 'filter-genre' || id === 'filter-country' || id === 'filter-year') applyFilter();
});

// Enter on the search / URL inputs — previously inline onkeydown handlers.
document.getElementById('search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
document.getElementById('url-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') watchByUrl();
});

/* ---- Init ---- */
(function init() {
  document.getElementById('browse-bar').style.display = 'flex';
  loadGrid('browse-grid', '/api/browse');
  updateTabChrome('browse');

  const m = location.pathname.match(/^\/movie\/([^/]+)$/);
  const s = location.pathname.match(/^\/series\/([^/]+)$/);
  if (m) openMovie(decodeURIComponent(m[1]), { pushHistory: false });
  else if (s) openSeries(decodeURIComponent(s[1]), { pushHistory: false });
})();
