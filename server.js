const express = require('express');
const path    = require('path');
const axios   = require('axios');
const cheerio = require('cheerio');
const scraper = require('./scraper');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LK21_ORIGIN = 'https://tv10.lk21official.cc';
const BROWSER_UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PLAYER_HDRS = {
  'User-Agent': BROWSER_UA,
  'Referer':    LK21_ORIGIN + '/',
  'Origin':     LK21_ORIGIN,
  'Accept':     'text/html,application/xhtml+xml,*/*',
};

// Injected into P2P proxy HTML:
//  1. Override XHR POST body so d=<anything> becomes d=tv10.lk21official.cc
//  2. Spoof document.referrer
//  3. Redirect api2.php XHR calls to our /api/p2p-api backend (avoids CORS)
const SPOOF_SCRIPT = `<script>
(function(){
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  var _apiTarget = null;

  XMLHttpRequest.prototype.open = function(method, url, async){
    if(url && (url.includes('api2.php') || url.match(/api2\\.php/))){
      var m = url.match(/[?&]id=([^&]+)/);
      url = '/api/p2p-api' + (m ? '?id=' + m[1] : '');
      _apiTarget = url;
    }
    _open.call(this, method, url, async !== false);
  };

  XMLHttpRequest.prototype.send = function(body){
    _send.call(this, body);
  };

  try {
    Object.defineProperty(document, 'referrer', {
      get: function(){ return '${LK21_ORIGIN}/'; },
      configurable: true
    });
  } catch(e){}
})();
</script>`;

/* ======================================================
   Scraper routes
   ====================================================== */

app.get(/^\/api\/movie\/(.+)$/, async (req, res) => {
  try {
    res.json(await scraper.getMovie(req.params[0]));
  } catch (e) {
    console.error('movie error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Resolve a source web URL to a slug so the frontend can open it directly.
// e.g. GET /api/slug-from-url?url=https://tv10.lk21official.cc/the-hunt-2012/
app.get('/api/slug-from-url', (req, res) => {
  const slug = scraper.slugFromSourceUrl(req.query.url || '');
  if (!slug) return res.status(400).json({ error: 'Not a valid lk21 URL' });
  res.json({ slug });
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);
    res.json(await scraper.search(q));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browse', async (req, res) => {
  try {
    res.json(await scraper.browse(req.query.path || ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
   SPA fallback
   ====================================================== */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SinepilStream running at http://localhost:${PORT}`));
