const { axios, cheerio, DEFAULT_HEADERS } = require('./http');

const PLAYER_HOST = 'https://playeriframe.sbs/';

function isSupportedPlayerUrl(url) {
  return typeof url === 'string' && url.startsWith(PLAYER_HOST);
}

// Resolve a playeriframe.sbs wrapper URL to its inner player iframe URL.
// Caller provides referer/origin appropriate to the source site.
async function resolveInnerUrl(playerUrl, { referer, origin } = {}) {
  try {
    const res = await axios.get(playerUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {}),
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

// Given raw {label, src} players, resolve each to a finalUrl the frontend can
// embed directly or must route through our proxy.
async function resolvePlayers(rawPlayers, { referer, origin } = {}) {
  const results = await Promise.allSettled(
    rawPlayers.map(p => resolveInnerUrl(p.src, { referer, origin }))
  );

  return rawPlayers.map((p, i) => {
    const innerUrl = results[i].status === 'fulfilled' ? results[i].value : null;

    // P2P (cloud.hownetwork.xyz) can't be embedded directly — drop silently
    if (/cloud\.hownetwork\.xyz/i.test(innerUrl || p.src)) return null;

    if (!innerUrl) {
      return { ...p, finalUrl: `/api/proxy?url=${encodeURIComponent(p.src)}`, proxied: true };
    }
    return { ...p, finalUrl: innerUrl, proxied: false, innerUrl };
  }).filter(Boolean);
}

module.exports = { PLAYER_HOST, isSupportedPlayerUrl, resolveInnerUrl, resolvePlayers };
