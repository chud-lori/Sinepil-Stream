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
let currentMovie   = null;
let currentPlayers = [];
let descExpanded   = false;

/* ---- Tab switching ---- */
function showTab(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('sec-' + name)?.classList.add('active');
  // 'search' has no nav-tab anymore — typing in the bar drives navigation directly.
  document.getElementById('tab-' + name)?.classList.add('active');
  document.getElementById('browse-bar').style.display = (name === 'browse') ? 'flex' : 'none';
  if (name === 'history')  renderHistory();
  if (name === 'wishlist') renderWishlist();
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

/* ---- Search ---- */
async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  showTab('search');
  loadGrid('search-grid', `/api/search?q=${encodeURIComponent(q)}`, 'search-count');
}

/* ---- Watch by URL ---- */
async function watchByUrl() {
  const input = document.getElementById('url-input');
  const url = input.value.trim();
  if (!url) return;
  const res = await fetch(`/api/slug-from-url?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (data.slug) {
    input.value = '';
    openMovie(data.slug);
    return;
  }
  toast('URL not recognised — must be a link from the source site');
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

async function clearHistory() {
  if (!confirm('Clear all watch history?')) return;
  History.clear();
  renderHistory();
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
  const poster = m.poster
    ? `<div class="card-img-wrap">
         <img class="card-img" src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy"
           onload="this.classList.add('loaded');this.parentElement.classList.add('loaded')"
           onerror="this.parentElement.style.display='none';this.parentElement.nextElementSibling.style.display='flex'">
       </div>`
    : '';
  const placeholder = `<div class="card-img-placeholder" ${m.poster ? 'style="display:none"' : ''}>&#127916;</div>`;
  const stars = m.rating ? `<span class="card-rating">&#9733; ${m.rating}</span>` : '';
  const year  = m.year   ? `<span class="card-year">${m.year}</span>` : '';

  let actions = '';
  if (opts.showDelete) {
    actions = `
      <div class="card-actions">
        <button class="card-btn" title="Remove"
          onclick="event.stopPropagation();removeItem('${esc(opts.ctx || '')}','${esc(m.slug)}')">&#x2715;</button>
      </div>`;
  } else {
    const mJson = esc(JSON.stringify(m));
    actions = `
      <div class="card-actions">
        <button class="card-btn${Wishlist.has(m.slug) ? ' active' : ''}" title="Wishlist"
          onclick="event.stopPropagation();quickWishlist(this,'${mJson}')">&#9825;</button>
      </div>`;
  }

  return `
    <div class="card" data-slug="${esc(m.slug)}">
      ${poster}${placeholder}
      ${actions}
      <div class="card-body">
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-meta">${stars}${year}</div>
      </div>
    </div>`;
}

function attachCardEvents(grid) {
  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openMovie(card.dataset.slug));
  });
}

/* ---- Remove from history/wishlist ---- */
function removeItem(ctx, slug) {
  if (ctx === 'wishlist') { Wishlist.remove(slug); renderWishlist(); toast('Removed from wishlist'); }
  else                    { History.remove(slug);  renderHistory();  toast('Removed from history'); }
}

/* ---- Quick wishlist toggle from card ---- */
function quickWishlist(btn, movieJson) {
  let movie;
  try { movie = JSON.parse(movieJson); } catch { return; }
  const added = Wishlist.toggle(movie);
  btn.classList.toggle('active', added);
  toast(added ? `Added "${movie.title}" to wishlist` : 'Removed from wishlist');
}

/* ---- Open movie modal ---- */
async function openMovie(slug, { pushHistory = true } = {}) {
  currentMovie   = null;
  currentPlayers = [];
  descExpanded   = false;

  if (pushHistory) {
    history.pushState({ slug }, '', '/movie/' + encodeURIComponent(slug));
  }

  document.getElementById('modal-overlay').classList.add('open');
  resetPlayer('Loading…');
  document.getElementById('player-tabs').innerHTML   = '';
  document.getElementById('modal-title').textContent = 'Loading…';
  document.getElementById('modal-meta').innerHTML    = '';
  document.getElementById('modal-desc').textContent  = '';
  document.getElementById('modal-cast').innerHTML    = '';
  document.getElementById('modal-poster').src        = '';
  document.getElementById('read-more-btn').style.display = 'none';

  try {
    const res  = await fetch(`/api/movie/${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.isSeries) {
      document.getElementById('modal-overlay').classList.remove('open');
      toast('This title is a TV series — not supported');
      return;
    }

    currentMovie = data;
    // Reorder players: CAST and HYDRAX tend to work; P2P and TURBOVIP often fail.
    const PLAYER_PRIORITY = ['CAST', 'HYDRAX', 'TURBOVIP'];
    currentPlayers = (data.players || []).slice().sort((a, b) => {
      const ai = PLAYER_PRIORITY.indexOf(a.label?.toUpperCase());
      const bi = PLAYER_PRIORITY.indexOf(b.label?.toUpperCase());
      const av = ai === -1 ? PLAYER_PRIORITY.length : ai;
      const bv = bi === -1 ? PLAYER_PRIORITY.length : bi;
      return av - bv;
    });

    renderModal(data);

    // Auto-load the first (most reliable) player
    if (currentPlayers.length > 0) loadPlayer(0);

    // Save to localStorage history
    History.upsert({
      slug: data.slug, title: data.title, poster: data.poster,
      year: data.year, rating: data.rating, genre: data.genre,
    });
  } catch (e) {
    document.getElementById('modal-title').textContent = 'Error loading movie';
    resetPlayer('Error: ' + e.message);
  }
}

function renderModal(data) {
  const posterEl = document.getElementById('modal-poster');
  // Remove 'loaded' first — CSS makes the img opacity:0 so no broken-icon flash.
  // The shimmer animates on the parent container until the image is ready.
  posterEl.classList.remove('loaded');
  posterEl.onload  = () => posterEl.classList.add('loaded');
  posterEl.onerror = () => posterEl.classList.add('loaded'); // hide shimmer even on error
  posterEl.src = data.poster || '';

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

  const tabsEl = document.getElementById('player-tabs');
  if (currentPlayers.length === 0) {
    tabsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">No player sources found.</span>';
  } else {
    tabsEl.innerHTML = currentPlayers.map((p, i) =>
      `<button class="ptab${i===0?' active':''}" onclick="loadPlayer(${i})">${esc(p.label || `Player ${i+1}`)}</button>`
    ).join('');
  }
}

/* ---- Load player (finalUrl pre-resolved during movie scrape — instant) ---- */
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
    src="${esc(playerUrl)}"
    allowfullscreen
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
    referrerpolicy="no-referrer"
  ></iframe>
  <button class="player-fullscreen-btn" id="player-fullscreen-btn"
          onclick="fullscreenPlayer()" title="Fullscreen" style="display:flex">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  </button>`;
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
      ? `<button class="btn btn-outline" style="margin-top:10px;font-size:12px" onclick="loadPlayer(${nextIndex})">
           Try ${esc(currentPlayers[nextIndex]?.label || 'Next Player')}
         </button>`
      : '<span style="font-size:12px;color:var(--muted)">No more players available</span>'
    }
  </div>`;
}

/* ---- Wishlist toggle (modal) ---- */
function toggleWishlist() {
  if (!currentMovie) return;
  const movie = {
    slug: currentMovie.slug, title: currentMovie.title, poster: currentMovie.poster,
    year: currentMovie.year, rating: currentMovie.rating, genre: currentMovie.genre,
  };
  const added = Wishlist.toggle(movie);
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
  currentPlayers = [];
  // Restore URL to home (only if we're currently on a /movie/ path)
  if (location.pathname.startsWith('/movie/')) {
    history.pushState({}, '', '/');
  }
}

/* ---- Share movie ---- */
function copyMovieLink() {
  if (!currentMovie) return;
  const url = location.origin + '/movie/' + encodeURIComponent(currentMovie.slug);
  const btn = document.getElementById('btn-copy-link');
  navigator.clipboard.writeText(url).then(() => {
    // In-button confirmation — no toast needed
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
  navigator.share({
    title: currentMovie.title,
    text: `Watch "${currentMovie.title}" on SinepilStream`,
    url: location.origin + '/movie/' + encodeURIComponent(currentMovie.slug),
  }).catch(() => {});
}

function resetPlayer(msg) {
  document.getElementById('player-wrap').innerHTML = `
    <div class="player-placeholder" id="player-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
        <circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16"/>
      </svg>
      <span>${msg || 'Select a player below to start watching'}</span>
    </div>
    <button class="player-fullscreen-btn" id="player-fullscreen-btn"
            onclick="fullscreenPlayer()" title="Fullscreen">
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
    // Navigated forward to a movie URL
    openMovie(e.state.slug, { pushHistory: false });
  } else {
    // Navigated back to '/'
    if (document.getElementById('modal-overlay').classList.contains('open')) {
      document.getElementById('modal-overlay').classList.remove('open');
      resetPlayer();
      currentMovie   = null;
      currentPlayers = [];
    }
  }
});

/* ---- Init ---- */
(function init() {
  document.getElementById('browse-bar').style.display = 'flex';
  loadGrid('browse-grid', '/api/browse');

  // Open movie if landing directly on /movie/:slug
  const m = location.pathname.match(/^\/movie\/([^/]+)$/);
  if (m) {
    openMovie(decodeURIComponent(m[1]), { pushHistory: false });
  }
})();
