// Replace upstream brand mentions in scraped free-form text (descriptions,
// titles, etc.) with our own brand. Without this, copy like "Saksikan di Lk21
// aksi seru..." leaks into our OG tags, link-share previews, and modal info.
//
// Kept regex-based and conservative: matches the names as standalone tokens
// (whitespace-separated digits allowed) so we don't mangle unrelated words.

const BRAND = 'SinepilStream';

function scrubSourceNames(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(/\blayar\s*kaca\s*21\b/gi, BRAND)   // layarkaca21 / layar kaca 21
    .replace(/\blk\s*21\b/gi,           BRAND)   // lk21
    .replace(/\bnontondrama\b/gi,       BRAND)
    .replace(/\s{2,}/g, ' ')                     // collapse double spaces from substitutions
    .trim();
}

module.exports = { scrubSourceNames };
