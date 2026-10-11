'use strict';
// End-to-end workflow test: signup -> generate book -> edit/reorder/replace -> upload photo -> PDF / ZIP / images.
// Runs against a real server instance with the DEMO image provider and a temporary data directory.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-'));
process.env.IMAGE_PROVIDER = 'demo';
process.env.ALLOW_DEV_PLAN_SWITCH = 'true';
process.env.NODE_ENV = 'test';
delete process.env.STRIPE_SECRET_KEY;
process.env.ANDROID_PACKAGE = 'app.colourbook.studio';
process.env.ANDROID_SHA256 = 'AA:BB:CC';

const { createApp } = require('../server/index');
const { PDFDocument } = require('pdf-lib');
const { unzipSync } = require('fflate');
const sharp = require('sharp');
const billing = require('../server/billing');
const crypto = require('crypto');

let server, base;
before(async () => { server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

function client() {
  let cookie = '';
  const call = async (method, url, body, extraHeaders = {}) => {
    const headers = { 'x-requested-with': 'fetch', ...(cookie ? { cookie } : {}), ...extraHeaders };
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b), raw: call };
}
async function waitReady(c, id, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await c.get(`/api/books/${id}`);
    if (data.book.status !== 'generating') return data.book;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for generation');
    await new Promise((r) => setTimeout(r, 250));
  }
}

const A = client();
let book;

test('auth: validation, signup, session, CSRF header, logout', async () => {
  assert.equal((await A.post('/api/auth/signup', { email: 'bad', password: 'longenough1' })).status, 400);
  assert.equal((await A.post('/api/auth/signup', { email: 'a@example.com', password: 'short' })).status, 400);
  const ok = await A.post('/api/auth/signup', { email: 'A@Example.com', password: 'correct horse', name: 'Asha' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.email, 'a@example.com');
  assert.equal((await A.post('/api/auth/signup', { email: 'a@example.com', password: 'correct horse' })).status, 409);
  assert.equal((await A.get('/api/me')).data.user.plan, 'free');
  assert.equal((await A.raw('POST', '/api/books', { topic: 'x' }, { 'x-requested-with': '' })).status, 403, 'CSRF header required');
  assert.equal((await client().get('/api/books')).status, 401);
  const bad = await client().post('/api/auth/login', { email: 'a@example.com', password: 'wrong password' });
  assert.equal(bad.status, 401);
});

test('plan limits: free plan cannot create 20-page books; validation errors are clear', async () => {
  const r = await A.post('/api/books', { topic: 'dinosaurs', pageCount: 20, ageGroup: '6-8' });
  assert.equal(r.status, 402); assert.equal(r.data.code, 'upgrade');
  assert.equal((await A.post('/api/books', { topic: 'dinosaurs', pageCount: 7, ageGroup: '6-8' })).status, 400);
  assert.equal((await A.post('/api/books', { topic: 'dinosaurs', pageCount: 10, ageGroup: '1-2' })).status, 400);
  assert.equal((await A.post('/api/books', { topic: ' ', pageCount: 10, ageGroup: '3-5' })).status, 400);
});

test('generate a 10-page book and wait for all pages', async () => {
  const r = await A.post('/api/books', { topic: 'dinosaurs', pageCount: 10, ageGroup: '3-5' });
  assert.equal(r.status, 201);
  assert.equal(r.data.book.pages.length, 10);
  book = await waitReady(A, r.data.book.id);
  assert.equal(book.status, 'ready');
  assert.ok(book.pages.every((p) => p.status === 'done'));
  const img = await A.get(`/api/books/${book.id}/pages/${book.pages[0].id}/image`);
  const meta = await sharp(img.data).metadata();
  assert.ok(meta.width >= 1500 && meta.height >= 2000, `hi-res page (${meta.width}x${meta.height})`);
  const stats = await sharp(img.data).stats();
  assert.ok(stats.channels[0].min === 0 && stats.channels[0].max === 255, 'pure black and white');
  const px = await sharp(img.data).raw().toBuffer();
  assert.equal(px.filter((v) => v !== 0 && v !== 255).length, 0, 'no grey pixels');
});

test('edit: rename, reorder, cover colour, replace page idea, add + delete page', async () => {
  const p = (await A.patch(`/api/books/${book.id}`, { title: 'Dino Fun', subtitle: 'Roar!', theme: { color: 'violet' } })).data.book;
  assert.equal(p.title, 'Dino Fun');
  const order = book.pages.map((x) => x.id).reverse();
  const re = (await A.patch(`/api/books/${book.id}`, { order })).data.book;
  assert.deepEqual(re.pages.map((x) => x.id), order);
  assert.equal((await A.patch(`/api/books/${book.id}`, { order: order.slice(1) })).status, 400);
  const target = re.pages[0];
  const upd = await A.post(`/api/books/${book.id}/pages/${target.id}/regenerate`, { idea: 'a smiling sun and clouds' });
  assert.equal(upd.status, 200);
  const done = await waitReady(A, book.id);
  assert.equal(done.pages[0].idea, 'a smiling sun and clouds');
  assert.equal(done.pages[0].version, target.version + 1, 'replacement bumps version');
  const removed = (await A.del(`/api/books/${book.id}/pages/${done.pages[9].id}`)).data.book;
  assert.equal(removed.pages.length, 9);
  const added = (await A.post(`/api/books/${book.id}/pages`, { idea: 'a happy rocket' })).data.book;
  assert.equal(added.pages.length, 10);
  book = await waitReady(A, book.id);
  assert.equal(book.pages[9].idea, 'a happy rocket'); assert.equal(book.status, 'ready');
});

test('free plan page cap applies when adding pages', async () => {
  const cur = (await A.get(`/api/books/${book.id}`)).data.book;
  assert.equal(cur.pages.length, 10);
  const r = await A.post(`/api/books/${book.id}/pages`, { idea: 'one more' });
  assert.equal(r.status, 402);
});

test('upload a photo and convert it to a colouring outline', async () => {
  const photo = await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 120, g: 170, b: 220 } } })
    .composite([{ input: Buffer.from('<svg width="900" height="1200"><circle cx="450" cy="500" r="260" fill="#d33"/><rect x="200" y="800" width="500" height="250" rx="60" fill="#2a2"/></svg>') }]).jpeg().toBuffer();
  const form = new FormData();
  form.set('image', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  form.set('mode', 'outline');
  form.set('pageId', book.pages[3].id);
  const r = await A.raw('POST', `/api/books/${book.id}/pages/upload`, form);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cur = await waitReady(A, book.id);
  const pg = cur.pages.find((p) => p.id === book.pages[3].id);
  assert.equal(pg.status, 'done'); assert.equal(pg.source, 'upload');
  const bad = new FormData(); bad.set('image', new Blob(['not an image'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await A.raw('POST', `/api/books/${book.id}/pages/upload`, bad)).status, 400);
  const fake = new FormData(); fake.set('image', new Blob(['not an image'], { type: 'image/png' }), 'x.png'); fake.set('pageId', book.pages[3].id);
  assert.equal((await A.raw('POST', `/api/books/${book.id}/pages/upload`, fake)).status, 400);
});

test('PDF: valid, A4 portrait, cover + title + numbered pages, opens with a standard reader', async () => {
  const r = await A.get(`/api/books/${book.id}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/pdf/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="dino-fun-A4\.pdf"/);
  assert.equal(r.data.subarray(0, 5).toString(), '%PDF-');
  const pdf = await PDFDocument.load(r.data);
  assert.equal(pdf.getPageCount(), 2 + 10, 'cover + title page + 10 pages');
  for (const pg of pdf.getPages()) {
    const { width, height } = pg.getSize();
    assert.ok(Math.abs(width - 595.28) < 0.1 && Math.abs(height - 841.89) < 0.1, `A4 portrait (${width}x${height})`);
  }
  assert.equal(pdf.getTitle(), 'Dino Fun');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'test-output.pdf'), r.data);
});

test('images: single page download, cover download and ZIP of all pages', async () => {
  book = (await A.get(`/api/books/${book.id}`)).data.book;
  const one = await A.get(`/api/books/${book.id}/pages/${book.pages[1].id}/image?download=1`);
  assert.match(one.headers.get('content-disposition'), /attachment; filename=".*page-02\.png"/);
  const cov = await A.get(`/api/books/${book.id}/cover?size=full&download=1`);
  assert.equal((await sharp(cov.data).metadata()).width, 2480);
  const z = await A.get(`/api/books/${book.id}/images.zip`);
  const files = unzipSync(new Uint8Array(z.data));
  assert.deepEqual(Object.keys(files).sort(), ['cover.png', ...Array.from({ length: 10 }, (_, i) => `page-${String(i + 1).padStart(2, '0')}.png`)].sort());
});

test('library: duplicate, rename, delete; other users cannot access my books', async () => {
  const dup = await A.post(`/api/books/${book.id}/duplicate`);
  assert.equal(dup.status, 201); assert.equal(dup.data.book.title, 'Copy of Dino Fun');
  const list = (await A.get('/api/books')).data.books;
  assert.equal(list.length, 2);
  const cp = await A.get(`/api/books/${dup.data.book.id}/pdf`);
  assert.equal((await PDFDocument.load(cp.data)).getPageCount(), 12, 'duplicate has copied images');
  const B = client();
  await B.post('/api/auth/signup', { email: 'b@example.com', password: 'another password' });
  assert.equal((await B.get(`/api/books/${book.id}`)).status, 404);
  assert.equal((await B.get(`/api/books/${book.id}/pdf`)).status, 404);
  assert.equal((await B.get(`/api/books/${book.id}/pages/${book.pages[0].id}/image`)).status, 404);
  assert.equal((await B.del(`/api/books/${book.id}`)).status, 404);
  assert.equal((await A.del(`/api/books/${dup.data.book.id}`)).status, 200);
  assert.equal((await A.get('/api/books')).data.books.length, 1);
});

test('premium plan unlocks 20+ page books, free footer removed from PDF, payments disabled until configured', async () => {
  assert.equal((await A.post('/api/billing/checkout')).status, 503);
  await A.post('/api/me/plan', { plan: 'premium' });
  const r = await A.post('/api/books', { topic: 'unicorn bakeries', pageCount: 20, ageGroup: 'adult', title: 'Mandala Mix' });
  assert.equal(r.status, 201);
  const b = await waitReady(A, r.data.book.id);
  assert.equal(b.pages.length, 20); assert.equal(b.status, 'ready');
  const pdf = await PDFDocument.load((await A.get(`/api/books/${b.id}/pdf`)).data);
  assert.equal(pdf.getPageCount(), 22);
});

test('Stripe webhook signature verification', () => {
  const body = JSON.stringify({ type: 'x' }), secret = 'whsec_test', t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.ok(billing.verifySignature(body, `t=${t},v1=${sig}`, secret));
  assert.ok(!billing.verifySignature(body + ' ', `t=${t},v1=${sig}`, secret));
  assert.ok(!billing.verifySignature(body, `t=${t - 4000},v1=${sig}`, secret), 'old timestamps rejected');
});

test('account: delete removes user and their books', async () => {
  assert.equal((await A.del('/api/me', { password: 'wrong' })).status, 403);
  assert.equal((await A.del('/api/me', { password: 'correct horse' })).status, 200);
  assert.equal((await A.get('/api/me')).status, 401);
});

test('PWA / Android packaging endpoints: manifest, service worker, offline page, assetlinks', async () => {
  const m = await fetch(base + '/manifest.webmanifest'); assert.equal(m.status, 200);
  const man = await m.json(); assert.equal(man.display, 'standalone'); assert.ok(man.icons.some((i) => i.sizes === '512x512'));
  const sw = await fetch(base + '/sw.js'); assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(base + '/offline.html')).status, 200);
  const al = await (await fetch(base + '/.well-known/assetlinks.json')).json();
  assert.equal(al[0].target.package_name, 'app.colourbook.studio'); assert.deepEqual(al[0].target.sha256_cert_fingerprints, ['AA:BB:CC']);
});
