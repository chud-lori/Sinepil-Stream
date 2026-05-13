// Pin Chromium download to the app directory (not ~/.cache) so deploys are
// self-contained, and skip the 350MB full Chrome — we only use the smaller
// chrome-headless-shell variant for token resolution (see lib/headless.js).

const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  chrome:              { skipDownload: true  },
  chromeHeadlessShell: { skipDownload: false },
};
