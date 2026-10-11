'use strict';
const sharp = require('sharp');

// A4 at 300 DPI
const A4_PX = { w: 2480, h: 3508 };
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const FONT = "'Baloo 2','Nunito','Noto Sans','Noto Sans Devanagari','DejaVu Sans',sans-serif";

// Turns any generated/uploaded image into a clean, print-ready page:
// white background, pure black outlines, ~2048x3072 px (about 300 DPI on an A4 printable area).
// sharp applies operations in its own fixed order (it would blur AFTER thresholding, leaving grey fringes),
// so each step that must happen in sequence runs as its own pipeline.
async function blurThenThreshold(buf, sigma, level) {
  const smooth = await sharp(buf).blur(sigma).toBuffer();
  return sharp(smooth).threshold(level).toColourspace('b-w').png({ compressionLevel: 9 }).toBuffer();
}
async function toPrintLineArt(buf) {
  const big = await sharp(buf, { limitInputPixels: 80e6 })
    .rotate()
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize({ width: 2048, height: 3072, fit: 'inside', kernel: 'lanczos3' })
    .toBuffer();
  return blurThenThreshold(big, 0.7, 175);
}

// Photo -> colouring outline ("pencil sketch" colour-dodge technique, then thicken and clean).
async function photoToOutline(buf) {
  const base = await sharp(buf, { limitInputPixels: 80e6 })
    .rotate().flatten({ background: '#ffffff' })
    .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true })
    .grayscale().normalise().toBuffer();
  const inv = await sharp(base).negate().blur(9).toBuffer();
  const sketch = await sharp(base).composite([{ input: inv, blend: 'colour-dodge' }]).toBuffer();
  const med = await sharp(sketch).median(3).toBuffer();
  const lines = await blurThenThreshold(med, 1.1, 222);
  const sized = await sharp(lines).resize({ width: 2048, height: 3072, fit: 'inside', kernel: 'lanczos3' }).toBuffer();
  return blurThenThreshold(sized, 0.8, 150);
}

async function resized(buf, width) {
  return sharp(buf).resize({ width, withoutEnlargement: true, kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}
const AGE_LABEL = { '3-5': 'Ages 3–5', '6-8': 'Ages 6–8', '9-12': 'Ages 9–12', adult: 'For Adults' };
const THEMES = {
  sunshine: { bg: '#FFC83D', accent: '#FF6B5B', ink: '#1F2340' },
  coral: { bg: '#FF8A7A', accent: '#FFC83D', ink: '#1F2340' },
  mint: { bg: '#5FD9B8', accent: '#6C4CF1', ink: '#1F2340' },
  sky: { bg: '#6DBBFF', accent: '#FFC83D', ink: '#1F2340' },
  violet: { bg: '#6C4CF1', accent: '#FFC83D', ink: '#FFFFFF' },
  night: { bg: '#1F2340', accent: '#FFC83D', ink: '#FFFFFF' },
};

// Cover: coloured background, white art panel (with one of the book's own illustrations), title, subtitle, age badge.
async function renderCover(book, artBuf, outWidth = A4_PX.w) {
  const th = THEMES[book.theme?.color] || THEMES.sunshine;
  const { w, h } = A4_PX;
  const lines = wrapText(book.title || 'My Colouring Book', 16);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const size = Math.min(300, Math.floor(1900 / Math.max(longest * 0.78, 4)));
  const titleY = 520;
  const titleSvg = lines.map((l, i) => `<text x="${w / 2}" y="${titleY + i * size * 1.1}" font-family="${FONT}" font-weight="800" font-size="${size}" text-anchor="middle" fill="${th.ink}">${esc(l)}</text>`).join('');
  const afterTitle = titleY + (lines.length - 1) * size * 1.1;
  const panelY = Math.max(afterTitle + 160, 1000);
  const panelBottom = 2850;
  const ph = Math.max(900, panelBottom - panelY);
  let art = '';
  if (artBuf) {
    const meta = await sharp(artBuf).metadata();
    const scale = Math.min((1800) / meta.width, (ph - 120) / meta.height);
    const aw = Math.round(meta.width * scale), ah = Math.round(meta.height * scale);
    const thumb = await sharp(artBuf).resize(aw, ah).png().toBuffer();
    art = `<image x="${(w - aw) / 2}" y="${panelY + (ph - ah) / 2}" width="${aw}" height="${ah}" href="data:image/png;base64,${thumb.toString('base64')}"/>`;
  }
  const dots = Array.from({ length: 18 }, (_, i) => `<circle cx="${(i * 677) % w}" cy="${(i * 911) % h}" r="${60 + (i % 4) * 30}" fill="${th.accent}" opacity="0.22"/>`).join('');
  const sub = book.subtitle ? `<text x="${w / 2}" y="${panelBottom + 400}" font-family="${FONT}" font-weight="700" font-size="100" text-anchor="middle" fill="${th.ink}">${esc(book.subtitle).slice(0, 48)}</text>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${th.bg}"/>${dots}
  ${titleSvg}
  ${sub}
  <rect x="300" y="${panelY}" width="${w - 600}" height="${ph}" rx="120" fill="#fff"/>${art}
  <rect x="${w / 2 - 950}" y="${panelBottom + 100}" width="1900" height="190" rx="95" fill="${th.accent}"/>
  <text x="${w / 2}" y="${panelBottom + 225}" font-family="${FONT}" font-weight="800" font-size="100" text-anchor="middle" fill="#1F2340">Colouring Book · ${esc(AGE_LABEL[book.ageGroup] || '')}</text>
  ${book.author ? `<text x="${w / 2}" y="${h - 110}" font-family="${FONT}" font-weight="700" font-size="84" text-anchor="middle" fill="${th.ink}">by ${esc(book.author).slice(0, 50)}</text>` : ''}
  </svg>`;
  let img = sharp(Buffer.from(svg), { density: 72 });
  if (outWidth !== w) img = img.resize({ width: outWidth });
  return img.png({ compressionLevel: 9 }).toBuffer();
}

async function renderTitlePage(book, outWidth = A4_PX.w) {
  const { w, h } = A4_PX;
  const th = THEMES[book.theme?.color] || THEMES.sunshine;
  const lines = wrapText(book.title || 'My Colouring Book', 18);
  const size = Math.min(230, Math.floor(1650 / Math.max(Math.max(...lines.map((l) => l.length)) * 0.78, 4)));
  const t = lines.map((l, i) => `<text x="${w / 2}" y="${1100 + i * size * 1.12}" font-family="${FONT}" font-weight="800" font-size="${size}" text-anchor="middle" fill="#000">${esc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#fff"/>
  <rect x="200" y="200" width="${w - 400}" height="${h - 400}" rx="90" fill="none" stroke="#000" stroke-width="14"/>
  <rect x="270" y="270" width="${w - 540}" height="${h - 540}" rx="60" fill="none" stroke="#000" stroke-width="5" stroke-dasharray="30 24"/>
  ${t}
  <text x="${w / 2}" y="${1100 + lines.length * size * 1.12 + 120}" font-family="${FONT}" font-weight="700" font-size="100" text-anchor="middle" fill="#000">${esc(AGE_LABEL[book.ageGroup] || '')}</text>
  <text x="${w / 2}" y="2500" font-family="${FONT}" font-weight="700" font-size="96" text-anchor="middle" fill="#000">This book belongs to</text>
  <line x1="600" y1="2680" x2="${w - 600}" y2="2680" stroke="#000" stroke-width="8"/>
  ${book.author ? `<text x="${w / 2}" y="2950" font-family="${FONT}" font-weight="700" font-size="90" text-anchor="middle" fill="#000">by ${esc(book.author).slice(0, 50)}</text>` : ''}
  </svg>`;
  let img = sharp(Buffer.from(svg), { density: 72 }).flatten({ background: '#fff' }).grayscale().toColourspace('b-w');
  if (outWidth !== w) img = img.resize({ width: outWidth });
  return img.png({ compressionLevel: 9 }).toBuffer();
}

module.exports = { toPrintLineArt, photoToOutline, resized, renderCover, renderTitlePage, THEMES, A4_PX };
