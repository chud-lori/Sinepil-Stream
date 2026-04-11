/**
 * Generates public/og-image.png — run once with: node generate-og-image.js
 * Matches the favicon design: dark bg, red gradient play triangle, curved arc.
 * Output: 1200×630 PNG (works on Facebook, Twitter/X, Telegram, WhatsApp,
 * LinkedIn, Discord, Slack, iMessage, and all other link-preview crawlers).
 */

const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const W = 1200;
const H = 630;

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// ---- Background ----
const bgGrad = ctx.createLinearGradient(0, 0, W, H);
bgGrad.addColorStop(0, '#0f0f13');
bgGrad.addColorStop(1, '#1a1a2e');
ctx.fillStyle = bgGrad;
ctx.fillRect(0, 0, W, H);

// ---- Top accent line ----
ctx.fillStyle = '#e50914';
ctx.globalAlpha = 0.9;
ctx.fillRect(0, 0, W, 5);
ctx.globalAlpha = 1;

// ---- Favicon replica (centered, large) ----
// The favicon is: dark rounded-rect bg + red play triangle + white curved arc
const FAV_SIZE = 220;   // replica size
const FAV_X    = W / 2; // centre x
const FAV_Y    = 220;   // centre y

// Rounded rect background (matching favicon #1a1a1a, rx=20%)
const rx = FAV_SIZE * 0.20;
const x0 = FAV_X - FAV_SIZE / 2;
const y0 = FAV_Y - FAV_SIZE / 2;
ctx.beginPath();
ctx.moveTo(x0 + rx, y0);
ctx.lineTo(x0 + FAV_SIZE - rx, y0);
ctx.quadraticCurveTo(x0 + FAV_SIZE, y0, x0 + FAV_SIZE, y0 + rx);
ctx.lineTo(x0 + FAV_SIZE, y0 + FAV_SIZE - rx);
ctx.quadraticCurveTo(x0 + FAV_SIZE, y0 + FAV_SIZE, x0 + FAV_SIZE - rx, y0 + FAV_SIZE);
ctx.lineTo(x0 + rx, y0 + FAV_SIZE);
ctx.quadraticCurveTo(x0, y0 + FAV_SIZE, x0, y0 + FAV_SIZE - rx);
ctx.lineTo(x0, y0 + rx);
ctx.quadraticCurveTo(x0, y0, x0 + rx, y0);
ctx.closePath();
// slight shadow so it lifts off the background
ctx.shadowColor = 'rgba(229,9,20,0.25)';
ctx.shadowBlur  = 40;
ctx.fillStyle   = '#1a1a1a';
ctx.fill();
ctx.shadowBlur  = 0;

// Red gradient play triangle — scaled from favicon viewBox 100→FAV_SIZE
const s = FAV_SIZE / 100;
const triGrad = ctx.createLinearGradient(
  x0 + 30 * s, y0 + 25 * s,
  x0 + 70 * s, y0 + 75 * s
);
triGrad.addColorStop(0, '#ff0000');
triGrad.addColorStop(1, '#8b0000');
ctx.beginPath();
ctx.moveTo(x0 + 30 * s, y0 + 25 * s);
ctx.lineTo(x0 + 70 * s, y0 + 50 * s);
ctx.lineTo(x0 + 30 * s, y0 + 75 * s);
ctx.closePath();
ctx.fillStyle = triGrad;
ctx.fill();

// White curved arc (favicon path: M35,35 Q40,40 40,50 Q40,60 35,65)
ctx.beginPath();
ctx.moveTo(x0 + 35 * s, y0 + 35 * s);
ctx.quadraticCurveTo(x0 + 40 * s, y0 + 40 * s, x0 + 40 * s, y0 + 50 * s);
ctx.quadraticCurveTo(x0 + 40 * s, y0 + 60 * s, x0 + 35 * s, y0 + 65 * s);
ctx.strokeStyle = '#ffffff';
ctx.lineWidth   = 4 * s;
ctx.lineCap     = 'round';
ctx.stroke();

// ---- App name ----
ctx.font         = '800 80px system-ui, -apple-system, Arial, sans-serif';
ctx.textAlign    = 'center';
ctx.textBaseline = 'alphabetic';
// "Sinepil" in white, "Stream" in red
const nameY = FAV_Y + FAV_SIZE / 2 + 90;
const sinepilWidth = ctx.measureText('Sinepil').width;
const streamWidth  = ctx.measureText('Stream').width;
const totalWidth   = sinepilWidth + streamWidth;
ctx.fillStyle = '#ffffff';
ctx.fillText('Sinepil', W / 2 - streamWidth / 2, nameY);
ctx.fillStyle = '#e50914';
ctx.fillText('Stream', W / 2 + sinepilWidth / 2, nameY);

// ---- Tagline ----
ctx.font      = '400 28px system-ui, -apple-system, Arial, sans-serif';
ctx.fillStyle = '#7070a0';
ctx.fillText('Watch movies. No ads. No noise.', W / 2, nameY + 52);

// ---- URL ----
ctx.font      = '500 22px system-ui, -apple-system, Arial, sans-serif';
ctx.fillStyle = '#3a3a5a';
ctx.fillText('sinepil.lori.my.id', W / 2, H - 36);

// ---- Write PNG ----
const out = path.join(__dirname, 'public', 'og-image.png');
fs.writeFileSync(out, canvas.toBuffer('image/png'));
console.log(`Written: ${out}  (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
