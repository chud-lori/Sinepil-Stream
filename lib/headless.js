// Headless Chromium wrapper.
//
// Why this exists: upstream (lk21 / nontondrama) switched their player URLs
// from plain `https://playeriframe.sbs/...` strings to AES-encrypted base64
// blobs that are only decrypted client-side by a heavily obfuscated player.js
// (obfuscator.io VM-based). Server-side decryption would require running their
// JS anyway, so we just spin up real Chromium, let upstream's own script run,
// and read the resulting iframe.src.
//
// Lifecycle: lazy launch, singleton, auto-close after IDLE_MS of no activity.
// First request pays ~2s cold-start; subsequent requests reuse the browser.
// Most page resolves are cached in SQLite for 12h (see resolver.js), so
// headless is only hit on cache misses.

const puppeteer = require('puppeteer');
const { USER_AGENT } = require('./http');

const IDLE_MS    = 5 * 60 * 1000; // close browser after 5min idle to free RAM
const NAV_TIMEOUT_MS = 25000;

let browser   = null;
let launching = null;
let idleTimer = null;
let pendingCount = 0;

async function getBrowser() {
  if (browser) return browser;
  if (launching) return launching;
  launching = puppeteer.launch({
    // 'shell' uses chrome-headless-shell (the small headless-only binary,
    // ~190MB) instead of the full Chrome build (~355MB). See .puppeteerrc.cjs
    // which skips downloading the full Chrome to keep deploys lean.
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',     // avoid /dev/shm exhaustion in containers
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-renderer-backgrounding',
      '--mute-audio',
    ],
  })
    .then((b) => { browser = b; return b; })
    .finally(() => { launching = null; });
  return launching;
}

function scheduleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (pendingCount > 0 || !browser) return;
    const b = browser;
    browser = null;
    try { await b.close(); } catch {}
    console.log('[headless] browser closed after idle');
  }, IDLE_MS);
  idleTimer.unref();
}

// Acquire a fresh page, run `fn(page)`, always clean up.
async function withPage(fn) {
  pendingCount++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent(USER_AGENT);
    // Speed up: drop ads, fonts, images, stylesheets. We only need scripts to
    // run and to observe iframe.src.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (t === 'image' || t === 'font' || t === 'media' || t === 'stylesheet') {
        req.abort();
      } else {
        req.continue();
      }
    });
    // Block popups (some source pages open ad popups via window.open)
    await page.evaluateOnNewDocument(() => {
      window.open = () => null;
    });
    return await fn(page);
  } finally {
    if (page) { try { await page.close(); } catch {} }
    pendingCount--;
    scheduleShutdown();
  }
}

// Graceful shutdown on signals
function shutdown() {
  if (browser) { try { browser.close(); } catch {} }
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

module.exports = { withPage, NAV_TIMEOUT_MS };
