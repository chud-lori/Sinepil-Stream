const { axios, cheerio, DEFAULT_HEADERS } = require('./http');
const { withPage, NAV_TIMEOUT_MS } = require('./headless');
const { readCache, writeCache } = require('./cache');

const PLAYER_HOST = 'https://playeriframe.sbs/';
const TOKEN_CACHE_TTL = 12 * 3600; // seconds

// Upstream now ships two flavours of player srcs:
//   1. Legacy plain URLs (https://playeriframe.sbs/...) — resolvable via HTTP.
//   2. AES-encrypted base64 blobs — only decryptable by upstream's own JS,
//      so we run it in headless Chromium and read the resulting iframe.src.
function isEncryptedToken(src) {
  return typeof src === 'string' && src && !/^https?:\/\//i.test(src);
}

function isSupportedPlayerUrl(url) {
  return typeof url === 'string' && url.startsWith(PLAYER_HOST);
}

// --- Legacy HTTP resolver (kept for any direct playeriframe.sbs URLs) ---
async function resolveInnerUrl(playerUrl, { referer, origin } = {}) {
  try {
    const res = await axios.get(playerUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        ...(referer ? { Referer: referer } : {}),
        ...(origin  ? { Origin:  origin  } : {}),
      },
      timeout: 8000,
      maxRedirects: 3,
    });
    const $ = cheerio.load(res.data);
    let innerUrl = '';
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || '';
      const h = parseInt($(el).attr('height') || '200', 10);
      const w = parseInt($(el).attr('width') || '200', 10);
      if (src && h > 1 && w > 1) { innerUrl = src; return false; }
    });
    if (!innerUrl) innerUrl = $('.embed-container iframe').first().attr('src') || '';
    return innerUrl || null;
  } catch {
    return null;
  }
}

// --- Headless resolver for encrypted tokens ---
// Loads the source page once, clicks through each player tab, captures the
// iframe.src that upstream's decrypted JS sets. Returns Map<token, iframeUrl>.
async function batchResolveOnPage(pageUrl, tokens) {
  return withPage(async (page) => {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Give player.js a moment to wire up click handlers
    await page.waitForSelector('#player-list a[data-url], .main-player', { timeout: 8000 }).catch(() => {});

    const results = {};
    for (const tok of tokens) {
      // Reset the iframe so we can detect when player.js writes the new src
      await page.evaluate(() => {
        const f = document.querySelector('#main-player iframe, .main-player iframe, #main-player-iframe');
        if (f) f.src = 'about:blank';
      });

      const clicked = await page.evaluate((src) => {
        const el = document.querySelector(`#player-list a[data-url="${src.replace(/"/g, '\\"')}"]`);
        if (!el) return false;
        el.click();
        return true;
      }, tok.src);
      if (!clicked) { results[tok.src] = null; continue; }

      const iframeUrl = await page.waitForFunction(
        () => {
          const f = document.querySelector('#main-player iframe, .main-player iframe, #main-player-iframe');
          if (!f || !f.src) return null;
          if (f.src === 'about:blank') return null;
          return /^https?:\/\//.test(f.src) ? f.src : null;
        },
        { timeout: 10000, polling: 200 }
      ).then((h) => h.jsonValue()).catch(() => null);

      results[tok.src] = iframeUrl || null;
    }
    return results;
  });
}

// Resolve encrypted tokens with per-token cache; batches misses into one page session.
// Two-step: headless gives us a `playeriframe.sbs/iframe/...` wrapper URL, then
// we HTTP-fetch that to extract the actual embed iframe inside it.
async function resolveEncrypted(pageUrl, tokens, { referer, origin }) {
  const hits = tokens.map((t) => readCache(`player:${t.src}`));
  const misses = tokens.filter((_, i) => !hits[i]);

  const wrapperByToken = {};
  if (misses.length && pageUrl) {
    let batch = null;
    try {
      batch = await batchResolveOnPage(pageUrl, misses);
    } catch (e) {
      console.warn('[resolver] headless batch failed:', e.message);
    }
    if (batch) Object.assign(wrapperByToken, batch);
  }

  // Step 2: resolve each wrapper URL to the deeper inner iframe. This is the
  // same HTTP path the legacy resolver used. Results cached per-token.
  const innerResults = await Promise.all(misses.map(async (t) => {
    const wrapper = wrapperByToken[t.src];
    if (!wrapper) return [t.src, null];
    const inner = isSupportedPlayerUrl(wrapper)
      ? await resolveInnerUrl(wrapper, { referer, origin })
      : wrapper; // Some tokens resolve to non-playeriframe URLs — pass through
    return [t.src, inner];
  }));

  for (const [src, finalUrl] of innerResults) {
    if (finalUrl) writeCache(`player:${src}`, finalUrl, TOKEN_CACHE_TTL);
  }
  const freshByToken = Object.fromEntries(innerResults);

  return tokens.map((t, i) => ({
    ...t,
    finalUrl: hits[i]?.value || freshByToken[t.src] || null,
  }));
}

// Given raw {label, src} players, resolve each to a finalUrl the frontend can
// embed. Routes encrypted tokens through headless Chromium, plain URLs through
// the legacy HTTP resolver.
async function resolvePlayers(rawPlayers, { referer, origin, pageUrl } = {}) {
  const encrypted = rawPlayers.filter((p) => isEncryptedToken(p.src));
  const legacy    = rawPlayers.filter((p) => !isEncryptedToken(p.src));

  const [encResolved, legacyResults] = await Promise.all([
    encrypted.length ? resolveEncrypted(pageUrl, encrypted, { referer, origin }) : Promise.resolve([]),
    legacy.length
      ? Promise.allSettled(legacy.map((p) => resolveInnerUrl(p.src, { referer, origin })))
      : Promise.resolve([]),
  ]);

  const legacyResolved = legacy.map((p, i) => ({
    ...p,
    finalUrl: legacyResults[i]?.status === 'fulfilled' ? legacyResults[i].value : null,
  }));

  // Preserve original order (encrypted/legacy can be interleaved in rawPlayers)
  const byKey = new Map();
  for (const r of [...encResolved, ...legacyResolved]) byKey.set(r.src, r);

  return rawPlayers.map((raw) => {
    const r = byKey.get(raw.src);
    if (!r) return null;
    // P2P (cloud.hownetwork.xyz) can't be embedded directly — drop silently
    if (/cloud\.hownetwork\.xyz/i.test(r.finalUrl || r.src)) return null;
    if (!r.finalUrl) {
      return { ...r, finalUrl: `/api/proxy?url=${encodeURIComponent(r.src)}`, proxied: true };
    }
    return { ...r, proxied: false, innerUrl: r.finalUrl };
  }).filter(Boolean);
}

module.exports = { PLAYER_HOST, isSupportedPlayerUrl, resolveInnerUrl, resolvePlayers };
