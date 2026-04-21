const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
};

async function fetchHtml(url, extraHeaders = {}) {
  const res = await axios.get(url, {
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
    timeout: 20000,
    maxRedirects: 5,
  });
  return { $: cheerio.load(res.data), finalUrl: res.request?.res?.responseUrl || url, raw: res };
}

// Promise.all with concurrency cap
async function pMap(items, mapper, limit = 8) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await mapper(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { axios, cheerio, USER_AGENT, DEFAULT_HEADERS, fetchHtml, pMap };
