'use strict';
// Exercises the REAL OpenAI provider code path against a local mock of the OpenAI Images API:
// request format, auth header, base64 decoding, retry on rate-limit, safety-filter errors, UI-facing retry.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const seen = { calls: 0, rateLimited: 0, bodies: [], auth: new Set() };
let mock, server, base, createApp;

before(async () => {
  // "AI-like" image: off-white paper, soft grey lines and grey shading (what real models often return)
  const aiImage = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect width="100%" height="100%" fill="#f4f0e6"/><circle cx="512" cy="700" r="300" fill="#dddddd" stroke="#2a2a2a" stroke-width="9"/><path d="M300 1100 Q512 1250 724 1100" stroke="#444" stroke-width="7" fill="none"/></svg>')).png().toBuffer();
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.calls += 1; seen.auth.add(req.headers.authorization);
      const body = JSON.parse(raw); seen.bodies.push({ url: req.url, ...body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (body.prompt.includes('forbidden')) return send(400, { error: { message: 'Your request was rejected by the safety system.' } });
      if (body.prompt.includes('Subject: a rate limited zebra') && seen.rateLimited < 1) { seen.rateLimited += 1; return send(429, { error: { message: 'rate limit' } }); }
      send(200, { data: [{ b64_json: aiImage.toString('base64') }] });
    });
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-oa-'));
  process.env.IMAGE_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  process.env.NODE_ENV = 'test';
  ({ createApp } = require('../server/index'));
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

let cookie = '';
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const waitReady = async (id) => { for (let i = 0; i < 400; i++) { const { data } = await call('GET', `/api/books/${id}`); if (data.book.status !== 'generating') return data.book; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

test('real provider path: key stays server-side, prompts are line-art specific, output is normalised to pure black/white', async () => {
  await call('POST', '/api/auth/signup', { email: 'ai@example.com', password: 'long enough pw' });
  const r = await call('POST', '/api/books', { topic: 'animals', pageCount: 10, ageGroup: '3-5' });
  assert.equal(r.status, 201);
  const book = await waitReady(r.data.book.id);
  assert.equal(book.status, 'ready', JSON.stringify(book.pages.filter((p) => p.status !== 'done')));
  assert.deepEqual([...seen.auth], ['Bearer sk-test-key']);
  const b = seen.bodies[0];
  assert.equal(b.url, '/v1/images/generations'); assert.equal(b.model, 'gpt-image-1'); assert.equal(b.size, '1024x1536'); assert.equal(b.n, 1);
  assert.match(b.prompt, /PURE WHITE background/); assert.match(b.prompt, /ages 3-5/); assert.match(b.prompt, /extra-thick/);
  const img = await call('GET', `/api/books/${book.id}/pages/${book.pages[0].id}/image`);
  const m = await sharp(img.data).metadata(); const st = await sharp(img.data).stats();
  assert.ok(m.width >= 1500, `upscaled to ${m.width}px wide`);
  assert.equal(st.channels[0].min, 0); assert.equal(st.channels[0].max, 255);
  const hist = await sharp(img.data).raw().toBuffer();
  let mid = 0; for (const v of hist) if (v > 0 && v < 255) mid++;
  assert.equal(mid, 0, 'no grey pixels: only black lines on white');
  assert.ok(!JSON.stringify(book).includes('sk-test-key'));
});

test('errors: safety-filter rejection shows a clear message and can be retried after rewording', async () => {
  const list = (await call('GET', '/api/books')).data.books;
  const book = (await call('GET', `/api/books/${list[0].id}`)).data.book;
  const pid = book.pages[2].id;
  await call('POST', `/api/books/${book.id}/pages/${pid}/regenerate`, { idea: 'a forbidden scene' });
  const bad = await waitReady(book.id);
  const p = bad.pages.find((x) => x.id === pid);
  assert.equal(p.status, 'error'); assert.match(p.error, /safety filter/i);
  assert.equal(bad.status, 'partial');
  const pdfWith = await call('GET', `/api/books/${book.id}/pdf`);
  assert.equal(pdfWith.status, 200, 'PDF still exports the finished pages');
  await call('PATCH', `/api/books/${book.id}/pages/${pid}`, { idea: 'a smiling sun' });
  const retry = await call('POST', `/api/books/${book.id}/retry-failed`);
  assert.equal(retry.status, 200);
  const ok = await waitReady(book.id);
  assert.equal(ok.status, 'ready');
});

test('rate limit from the provider is retried automatically', async () => {
  const id = (await call('GET', '/api/books')).data.books[0].id;
  const book = (await call('GET', `/api/books/${id}`)).data.book;
  assert.equal(seen.rateLimited, 0);
  await call('POST', `/api/books/${book.id}/pages/${book.pages[0].id}/regenerate`, { idea: 'a rate limited zebra' });
  const done = await waitReady(book.id);
  assert.equal(done.pages[0].status, 'done');
  assert.equal(seen.rateLimited, 1, 'one 429 was returned, then the request was retried and succeeded');
});
