'use strict';
const zlib = require('zlib');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = require('pdf-lib');
const store = require('./store');
const imaging = require('./imaging');

const MM = 72 / 25.4;
const A4 = { w: 210 * MM, h: 297 * MM };       // 595.28 x 841.89 pt, portrait
const MARGIN = 15 * MM;                           // 15 mm safe margin on every side
const NUMBER_ZONE = 8 * MM;                       // extra room at the bottom for the page number

// Fast, tiny embedding for pure black/white line art: 1 bit per pixel + Flate (a 2048x3072 page becomes ~20-80 KB
// and embeds in milliseconds; pdf-lib's own PNG decoder would take ~0.5 s per page).
async function embedBilevel(pdf, pngBuf) {
  const { data, info } = await sharp(pngBuf).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rowBytes = Math.ceil(width / 8);
  const packed = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = y * width, dst = y * rowBytes;
    for (let x = 0; x < width; x++) if (data[src + x] > 127) packed[dst + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const stream = pdf.context.stream(zlib.deflateSync(packed, { level: 9 }), {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'FlateDecode',
  });
  return { ref: pdf.context.register(stream), width, height };
}
function drawEmbedded(page, img, x, y, w, h) {
  const name = page.node.newXObject('Image', img.ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

async function loadPageBuffer(book, page) {
  return store.readPageImage(book.id, page.id);
}

// Builds the complete print-ready PDF: cover, title page, numbered colouring pages.
async function buildBookPdf(book, plan) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(book.title || 'Colouring Book');
  pdf.setAuthor(book.author || 'ColourBook Studio AI');
  pdf.setSubject(`Colouring book - ${book.ageGroup}`);
  pdf.setProducer('ColourBook Studio AI');
  pdf.setCreator('ColourBook Studio AI');
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const pages = book.pages.filter((p) => p.status === 'done');
  const coverSrc = pages.find((p) => p.id === book.theme?.coverPageId) || pages[0];
  const coverArt = coverSrc ? await loadPageBuffer(book, coverSrc) : null;

  // Cover is a colour image (JPEG q92, 4:4:4 keeps the flat colours and text crisp); title page is bilevel.
  const coverPng = await imaging.renderCover(book, coverArt, 2480);
  const coverJpg = await sharp(coverPng).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
  const coverPage = pdf.addPage([A4.w, A4.h]);
  coverPage.drawImage(await pdf.embedJpg(coverJpg), { x: 0, y: 0, width: A4.w, height: A4.h });
  if (book.settings?.includeTitlePage !== false) {
    const tp = pdf.addPage([A4.w, A4.h]);
    drawEmbedded(tp, await embedBilevel(pdf, await sharp(await imaging.renderTitlePage(book, 2480)).threshold(160).toColourspace('b-w').png().toBuffer()), 0, 0, A4.w, A4.h);
  }

  let n = 0;
  for (const p of pages) {
    n += 1;
    const png = await loadPageBuffer(book, p);
    const img = await embedBilevel(pdf, png);
    const page = pdf.addPage([A4.w, A4.h]);
    const boxX = MARGIN, boxY = MARGIN + NUMBER_ZONE, boxW = A4.w - 2 * MARGIN, boxH = A4.h - 2 * MARGIN - NUMBER_ZONE;
    const scale = Math.min(boxW / img.width, boxH / img.height);
    const w = img.width * scale, h = img.height * scale;
    drawEmbedded(page, img, boxX + (boxW - w) / 2, boxY + (boxH - h) / 2, w, h);
    if (book.settings?.showPageNumbers !== false) {
      const label = String(n);
      const size = 11;
      page.drawText(label, { x: A4.w / 2 - font.widthOfTextAtSize(label, size) / 2, y: MARGIN * 0.55, size, font, color: rgb(0, 0, 0) });
    }
    if (plan?.footer) {
      const t = 'Made with ColourBook Studio AI';
      page.drawText(t, { x: MARGIN, y: MARGIN * 0.55, size: 7, font, color: rgb(0.45, 0.45, 0.45) });
    }
  }
  if (n === 0) throw new Error('This book has no finished pages yet.');
  return pdf.save();
}
module.exports = { buildBookPdf, A4, MARGIN };
