const express = require('express');
const path    = require('path');
const axios   = require('axios');
const cheerio = require('cheerio');
const scraper = require('./scraper');

const app = express();
app.use(express.json());
// Force browsers to revalidate static assets (CSS/JS/HTML) on every request.
// Without this, Chrome's heuristic cache silently serves stale files for hours
// after a deploy — UI changes appear "broken" until the user hard-refreshes.
// ETag/Last-Modified still apply, so unchanged files return 304 (cheap).
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      // Images, fonts, favicons — safe to cache for a day.
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

const LK21_ORIGIN = 'https://tv10.lk21official.cc';
const BROWSER_UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PLAYER_HDRS = {
  'User-Agent': BROWSER_UA,
  'Referer':    LK21_ORIGIN + '/',
  'Origin':     LK21_ORIGIN,
  'Accept':     'text/html,application/xhtml+xml,*/*',
};

// Injected into every proxied player page:
//  1. Override XHR so api2.php calls route through our /api/p2p-api (CORS fix)
//  2. Spoof document.referrer
//  3. Block all popup / popunder / redirect ad techniques
const SPOOF_SCRIPT = `<script>
(function(){
  /* --- XHR intercept for P2P api2.php --- */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async){
    if(url && url.includes('api2.php')){
      var m = url.match(/[?&]id=([^&]+)/);
      url = '/api/p2p-api' + (m ? '?id=' + m[1] : '');
    }
    _xhrOpen.call(this, method, url, async !== false);
  };

  /* --- Spoof referrer --- */
  try {
    Object.defineProperty(document, 'referrer', {
      get: function(){ return '${LK21_ORIGIN}/'; },
      configurable: true
    });
  } catch(e){}

  /* --- Ad blocker: kill every popup / redirect technique --- */

  // 1. window.open → no-op (covers popunders, new-tab ads)
  window.open = function(){ return null; };

  // 2. Prevent top-frame navigation (window.top.location = ...)
  try {
    Object.defineProperty(window, 'top', { get: function(){ return window; } });
  } catch(e){}

  // 3. Block fetch/XHR to known ad domains
  var AD_HOSTS = /popads|popcash|popunder|exoclick|juicyads|trafficjunky|hilltopads|adcash|propellerads|adsterra|monetag|yllix|olavivo|clickaine/i;
  var _fetch = window.fetch;
  window.fetch = function(input){
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if(AD_HOSTS.test(url)) return Promise.resolve(new Response('', {status:204}));
    return _fetch.apply(this, arguments);
  };

  // 4. Strip body/document onclick ad triggers after DOM is ready
  document.addEventListener('DOMContentLoaded', function(){
    document.body && (document.body.onclick = null);
    document.documentElement.onclick = null;
  }, { once: true });

  // 5. Block programmatic anchor clicks that bypass window.open
  document.addEventListener('click', function(e){
    var el = e.target && e.target.closest('a');
    if(el && el.target === '_blank' && !el.href.includes(location.hostname)){
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
})();
</script>`;

/* ======================================================
   Scraper routes
   ====================================================== */

// Whitelist characters accepted in user-supplied browse paths before
// interpolating into source URLs. Allows letters/digits/dashes/slashes only.
const BROWSE_PATH_RE = /^[a-z0-9/-]{0,100}$/i;
function isSafeBrowsePath(p) {
  return typeof p === 'string' && BROWSE_PATH_RE.test(p);
}

function sendErr(res, e) {
  const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
  // Don't leak stack traces; only message
  res.status(status).json({ error: e?.message || 'Internal error' });
}

app.get(/^\/api\/movie\/(.+)$/, async (req, res) => {
  try {
    if (!scraper.isSafeSlug(req.params[0])) return res.status(400).json({ error: 'Invalid slug' });
    res.json(await scraper.getMovie(req.params[0]));
  } catch (e) {
    console.error('movie error:', e.message);
    sendErr(res, e);
  }
});

app.get(/^\/api\/series\/([^/]+)$/, async (req, res) => {
  try {
    if (!scraper.isSafeSlug(req.params[0])) return res.status(400).json({ error: 'Invalid slug' });
    res.json(await scraper.getSeries(req.params[0]));
  } catch (e) {
    console.error('series error:', e.message);
    sendErr(res, e);
  }
});

app.get(/^\/api\/episode\/([^/]+)\/(\d{1,2})\/(\d{1,3})$/, async (req, res) => {
  try {
    const [, slug, s, e] = req.params ? [null, req.params[0], req.params[1], req.params[2]] : [];
    if (!scraper.isSafeSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
    res.json(await scraper.getEpisode(slug, s, e));
  } catch (err) {
    console.error('episode error:', err.message);
    sendErr(res, err);
  }
});

// Resolve a source web URL to a {kind, slug, [season, episode]} so the frontend
// can route to the right modal.
// Supports lk21 movie URLs and nontondrama series/episode URLs.
app.get('/api/slug-from-url', (req, res) => {
  const hit = scraper.fromSourceUrl(req.query.url || '');
  if (!hit) return res.status(400).json({ error: 'Not a recognised lk21 or nontondrama URL' });
  res.json(hit);
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);
    const kind = ['movie', 'series', 'all'].includes(req.query.kind) ? req.query.kind : 'all';
    res.json(await scraper.search(q, kind));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/browse', async (req, res) => {
  try {
    const p = req.query.path || '';
    if (!isSafeBrowsePath(p)) return res.status(400).json({ error: 'Invalid path' });
    res.json(await scraper.browse(p));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/browse/series', async (req, res) => {
  try {
    const p = req.query.path || '';
    if (!isSafeBrowsePath(p)) return res.status(400).json({ error: 'Invalid path' });
    res.json(await scraper.browseSeries(p));
  } catch (e) { sendErr(res, e); }
});

/* ======================================================
   P2P API proxy — called by the spoofed XHR in the player
   Forwards api2.php call from our server with correct domain
   ====================================================== */

app.post('/api/p2p-api', async (req, res) => {
  const id = req.query.id || '';
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const result = await axios.post(
      `https://cloud.hownetwork.xyz/api2.php?id=${encodeURIComponent(id)}`,
      `r=${encodeURIComponent(LK21_ORIGIN + '/')}&d=tv10.lk21official.cc`,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          'Referer':    `https://cloud.hownetwork.xyz/video.php?id=${id}`,
          'Origin':     'https://cloud.hownetwork.xyz',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
    res.set('Access-Control-Allow-Origin', '*');
    res.json(result.data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// OPTIONS preflight for p2p-api
app.options('/api/p2p-api', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

/* ======================================================
   Player resolver
   - Fetches playeriframe.sbs wrapper (site Referer)
   - Extracts inner player URL, follows URL-shortener redirects
   - Returns direct URL if no CSP, else routes through /api/proxy
   ====================================================== */

app.get('/api/resolve', async (req, res) => {
  const url = req.query.url || '';
  if (!url.startsWith('https://playeriframe.sbs/')) {
    return res.status(400).json({ error: 'Only playeriframe.sbs URLs supported' });
  }

  try {
    // Fetch the wrapper page
    const wrapper = await axios.get(url, {
      headers: PLAYER_HDRS,
      timeout: 12000,
      maxRedirects: 5,
    });

    // Extract inner player iframe (skip 1×1 CF challenge iframes)
    const $ = cheerio.load(wrapper.data);
    let innerUrl = '';
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || '';
      const h   = parseInt($(el).attr('height') || '200', 10);
      const w   = parseInt($(el).attr('width')  || '200', 10);
      if (src && h > 1 && w > 1) { innerUrl = src; return false; }
    });
    if (!innerUrl) innerUrl = $('.embed-container iframe').first().attr('src') || '';
    if (!innerUrl) return res.status(404).json({ error: 'No inner player found' });

    // Follow redirects (handles URL shorteners like short.icu)
    let finalUrl = innerUrl;
    let cspHeader = '';
    try {
      const check = await axios.head(innerUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://playeriframe.sbs/' },
        timeout: 8000,
        maxRedirects: 10,
      });
      // After following redirects, get the final URL
      finalUrl  = check.request?.res?.responseUrl || check.request?.path
                  ? (check.request.res?.responseUrl || innerUrl)
                  : innerUrl;
      cspHeader = check.headers['content-security-policy'] || '';
    } catch (e) {
      // On error keep innerUrl, assume needs proxy
      cspHeader = 'frame-ancestors blocked';
    }

    const needsProxy = cspHeader.includes('frame-ancestors');

    if (needsProxy) {
      res.json({ url: `/api/proxy?url=${encodeURIComponent(finalUrl)}`, proxied: true });
    } else {
      res.json({ url: finalUrl, proxied: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ======================================================
   Generic proxy
   - Fetches URL with lk21 Referer from our server
   - Strips CSP frame-ancestors so iframe embedding works
   - For HTML: injects <base href> + spoof script
   ====================================================== */

app.get('/api/proxy', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.status(400).send('Missing url');

  // Only allow http/https URLs (prevent SSRF to internal services)
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).send('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(403).send('Forbidden');
  }
  // Block private/local addresses
  const host = parsedUrl.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)) {
    return res.status(403).send('Forbidden');
  }

  try {
    const response = await axios.get(url, {
      headers: {
        ...PLAYER_HDRS,
        Referer: 'https://playeriframe.sbs/',
        Origin:  'https://playeriframe.sbs',
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 10,
    });

    const ct = response.headers['content-type'] || 'text/html';
    res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    // Do NOT forward CSP or X-Frame-Options

    if (ct.includes('text/html')) {
      let html = Buffer.from(response.data).toString('utf-8');

      // Determine base origin from the final resolved URL
      let baseHref = url;
      try { baseHref = new URL(url).origin + '/'; } catch {}

      // Inject base href + spoof script into <head>
      const inject = `<base href="${baseHref}">${SPOOF_SCRIPT}`;
      html = html.includes('<head>')
        ? html.replace('<head>', `<head>${inject}`)
        : inject + html;

      // Strip meta CSP tags
      html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

      // Strip external ad scripts by known ad-network domains
      html = html.replace(
        /<script[^>]+src=["'][^"']*(?:popads|popcash|popunder|exoclick|juicyads|trafficjunky|hilltopads|adcash|propellerads|adsterra|monetag|yllix|olavivo|clickaine|revcontent)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
      );

      res.send(html);
    } else {
      const fwd = ['cache-control', 'content-encoding'];
      fwd.forEach(h => { if (response.headers[h]) res.set(h, response.headers[h]); });
      res.send(Buffer.from(response.data));
    }
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
});

/* ======================================================
   /movie/:slug — bot-aware OG meta renderer
   Regular browsers get index.html (SPA handles it).
   Crawlers (WhatsApp, Telegram, Twitter, etc.) get a
   minimal HTML page with movie-specific OG tags so the
   link preview shows the actual poster + title.
   ====================================================== */

const BOT_UA = /WhatsApp|Telegram|TelegramBot|Twitterbot|facebookexternalhit|LinkedInBot|Discordbot|Slackbot-Linkexpanding|Applebot|Googlebot|bingbot/i;

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/movie/:slug', async (req, res, next) => {
  // Let regular browsers fall through to the SPA
  if (!BOT_UA.test(req.headers['user-agent'] || '')) return next();

  try {
    const data = await scraper.getMovie(req.params.slug);
    if (!data || data.isSeries || data.error) return next();

    const title = data.title + (data.year ? ` (${data.year})` : '') + ' — SinepilStream';
    const desc  = (data.description || `Watch ${data.title} on SinepilStream — ad-free.`).slice(0, 200);
    const image = data.poster || `https://${req.headers.host}/og-image.png`;
    const url   = `https://${req.headers.host}/movie/${encodeURIComponent(req.params.slug)}`;

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)}</title>
  <meta property="og:type" content="video.movie">
  <meta property="og:site_name" content="SinepilStream">
  <meta property="og:url" content="${escHtml(url)}">
  <meta property="og:title" content="${escHtml(title)}">
  <meta property="og:description" content="${escHtml(desc)}">
  <meta property="og:image" content="${escHtml(image)}">
  <meta property="og:image:alt" content="${escHtml(data.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(title)}">
  <meta name="twitter:description" content="${escHtml(desc)}">
  <meta name="twitter:image" content="${escHtml(image)}">
  <link rel="canonical" href="${escHtml(url)}">
  <!-- Redirect browsers that somehow land here to the SPA -->
  <meta http-equiv="refresh" content="0;url=${escHtml(url)}">
</head>
<body></body>
</html>`);
  } catch {
    next();
  }
});

/* ======================================================
   SPA fallback
   ====================================================== */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`SinepilStream running at http://localhost:${PORT}`);
  scraper.startSeeding();
  // Signal PM2 that the process is ready — required for zero-downtime reload.
  // pm2 reload waits for this before killing the old process.
  if (process.send) process.send('ready');
});

// Graceful shutdown — finish in-flight requests before exiting.
// Triggered by PM2 reload (SIGINT) or docker stop (SIGTERM).
function shutdown(signal) {
  console.log(`[${signal}] Shutting down gracefully…`);
  server.close(() => {
    console.log('All connections closed. Exiting.');
    process.exit(0);
  });
  // Force-exit after 15 s if connections are stuck
  setTimeout(() => { console.warn('Force exit after timeout'); process.exit(1); }, 15000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
