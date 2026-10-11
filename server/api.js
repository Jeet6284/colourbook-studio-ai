'use strict';
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');
const { zipSync } = require('fflate');
const cfg = require('./config');
const store = require('./store');
const auth = require('./auth');
const jobs = require('./jobs');
const billing = require('./billing');
const imaging = require('./imaging');
const { buildBookPdf } = require('./pdf');
const { makeIdeas } = require('./ideas');
const providers = require('./providers');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const planOf = (u) => cfg.plans[u.plan] || cfg.plans.free;
const slug = (s) => clean(s, 60).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'colouring-book';
const today = () => new Date().toISOString().slice(0, 10);

// ---------- rate limiting ----------
const mk = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down and try again shortly.' } });
router.use(mk(15 * 60 * 1000, 1500));
const authLimiter = mk(15 * 60 * 1000, 30);
const exportLimiter = mk(10 * 60 * 1000, 40);
const genLimiter = mk(60 * 60 * 1000, 300);

// ---------- public ----------
router.get('/config', (_req, res) => res.json({
  provider: cfg.provider, demo: cfg.provider === 'demo', pageOptions: cfg.pageOptions, ageGroups: cfg.ageGroups,
  categories: cfg.categories, plans: cfg.plans, paymentsEnabled: billing.enabled(), devPlanSwitch: cfg.devPlanSwitch,
  themes: Object.keys(imaging.THEMES).map((id) => ({ id, ...imaging.THEMES[id] })), signupsOpen: cfg.signupsOpen,
}));

// ---------- auth ----------
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, plan: u.plan, createdAt: u.createdAt, hasBilling: Boolean(u.stripeCustomerId) });
router.post('/auth/signup', authLimiter, wrap(async (req, res) => {
  if (!cfg.signupsOpen) throw new HttpError(403, 'Sign-ups are closed.');
  const email = store.normEmail(req.body.email), password = String(req.body.password || ''), name = clean(req.body.name, 60);
  if (!/^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8–128 characters.');
  if (store.findUserByEmail(email)) throw new HttpError(409, 'An account with this email already exists.');
  const user = await store.createUser({ email, name: name || email.split('@')[0], passHash: auth.hashPassword(password) });
  auth.setSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
}));
router.post('/auth/login', authLimiter, wrap(async (req, res) => {
  const user = store.findUserByEmail(req.body.email);
  const ok = user ? auth.verifyPassword(String(req.body.password || ''), user.passHash) : (auth.verifyPassword('x', 'scrypt$00$00'), false);
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  auth.setSession(res, user.id);
  res.json({ user: publicUser(user) });
}));
router.post('/auth/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

router.use(auth.requireAuth);

// ---------- account ----------
function usageOf(u) {
  const plan = planOf(u);
  const used = u.usage?.day === today() ? u.usage.generations : 0;
  return { generationsToday: used, generationsLimit: plan.dailyGenerations };
}
async function consume(user, n) {
  const plan = planOf(user);
  const used = user.usage?.day === today() ? user.usage.generations : 0;
  if (used + n > plan.dailyGenerations) {
    throw new HttpError(429, `Daily image limit reached (${plan.dailyGenerations} on the ${plan.name} plan). Try again tomorrow${plan.id === 'free' ? ' or upgrade to Premium' : ''}.`, { code: plan.id === 'free' ? 'upgrade' : 'limit' });
  }
  await store.updateUser(user.id, { usage: { day: today(), generations: used + n } });
}
router.get('/me', (req, res) => res.json({
  user: publicUser(req.user), plan: planOf(req.user), usage: usageOf(req.user), booksCount: store.listBooks(req.user.id).length,
}));
router.patch('/me', wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) throw new HttpError(400, 'Name cannot be empty.');
  res.json({ user: publicUser(await store.updateUser(req.user.id, { name })) });
}));
router.post('/me/password', authLimiter, wrap(async (req, res) => {
  if (!auth.verifyPassword(String(req.body.current || ''), req.user.passHash)) throw new HttpError(403, 'Current password is incorrect.');
  const next = String(req.body.next || '');
  if (next.length < 8 || next.length > 128) throw new HttpError(400, 'New password must be 8–128 characters.');
  await store.updateUser(req.user.id, { passHash: auth.hashPassword(next) });
  res.json({ ok: true });
}));
router.post('/me/plan', wrap(async (req, res) => {
  if (!cfg.devPlanSwitch) throw new HttpError(403, 'Plan switching is disabled. Use the upgrade button.');
  const plan = req.body.plan === 'premium' ? 'premium' : 'free';
  res.json({ user: publicUser(await store.updateUser(req.user.id, { plan })) });
}));
router.delete('/me', authLimiter, wrap(async (req, res) => {
  if (!auth.verifyPassword(String(req.body.password || ''), req.user.passHash)) throw new HttpError(403, 'Password is incorrect.');
  for (const b of store.listBooks(req.user.id)) await store.removeBook(b.id);
  await store.deleteUser(req.user.id);
  auth.clearSession(res);
  res.json({ ok: true });
}));

// ---------- billing ----------
router.post('/billing/checkout', wrap(async (req, res) => {
  if (!billing.enabled()) throw new HttpError(503, 'Payments are not configured on this server yet.', { code: 'payments_disabled' });
  res.json({ url: await billing.createCheckout(req, req.user) });
}));
router.post('/billing/portal', wrap(async (req, res) => {
  if (!billing.enabled() || !req.user.stripeCustomerId) throw new HttpError(503, 'No billing account to manage.');
  res.json({ url: await billing.createPortal(req, req.user) });
}));

// ---------- books ----------
const pubPage = (p) => ({ id: p.id, idea: p.idea, status: p.status, error: p.error, version: p.version, source: p.source });
const pubBook = (b) => ({
  id: b.id, title: b.title, subtitle: b.subtitle, author: b.author, topic: b.topic, ageGroup: b.ageGroup, status: b.status,
  theme: b.theme, settings: b.settings, createdAt: b.createdAt, updatedAt: b.updatedAt, pages: b.pages.map(pubPage),
});
const summary = (b) => {
  const done = b.pages.filter((p) => p.status === 'done');
  const cover = done.find((p) => p.id === b.theme.coverPageId) || done[0];
  return { id: b.id, title: b.title, topic: b.topic, ageGroup: b.ageGroup, status: b.status, pageCount: b.pages.length, donePages: done.length, updatedAt: b.updatedAt, theme: b.theme, thumbPageId: cover?.id, thumbVersion: cover?.version };
};
function ownedBook(req) {
  const b = store.getBook(req.params.id);
  if (!b || b.ownerId !== req.user.id) throw new HttpError(404, 'Book not found.');
  return b;
}
function ownedPage(req, book) {
  const p = book.pages.find((x) => x.id === req.params.pid);
  if (!p) throw new HttpError(404, 'Page not found.');
  return p;
}
const titleFor = (topic) => `${topic.replace(/\b\p{L}/gu, (c) => c.toUpperCase())} Colouring Book`.slice(0, 80);
const newPage = (idea, source = 'ai') => ({ id: store.newId(), idea: clean(idea, 200), status: 'pending', error: '', version: 0, source });

router.get('/books', (req, res) => res.json({ books: store.listBooks(req.user.id).map(summary) }));

router.post('/books', genLimiter, wrap(async (req, res) => {
  const plan = planOf(req.user);
  const topic = clean(req.body.topic, 80);
  const pageCount = Number(req.body.pageCount);
  const ageGroup = String(req.body.ageGroup);
  if (topic.length < 2) throw new HttpError(400, 'Enter a topic (at least 2 characters), e.g. "dinosaurs".');
  if (!cfg.pageOptions.includes(pageCount)) throw new HttpError(400, `Choose ${cfg.pageOptions.join(', ')} pages.`);
  if (!cfg.ageGroups.some((a) => a.id === ageGroup)) throw new HttpError(400, 'Choose an age group.');
  if (pageCount > plan.maxPagesPerBook) throw new HttpError(402, `The ${plan.name} plan allows up to ${plan.maxPagesPerBook} pages per book. Upgrade to Premium for up to 50.`, { code: 'upgrade' });
  if (store.listBooks(req.user.id).length >= plan.maxBooks) throw new HttpError(402, `The ${plan.name} plan allows ${plan.maxBooks} saved books. Delete one or upgrade to Premium.`, { code: 'upgrade' });
  await consume(req.user, pageCount);
  const pages = makeIdeas(topic, pageCount).map((i) => newPage(i));
  const book = await store.createBook({
    ownerId: req.user.id, title: clean(req.body.title, 80) || titleFor(topic), subtitle: '', author: clean(req.body.author, 50) || req.user.name,
    topic, ageGroup, status: 'generating', pages,
    theme: { color: Object.keys(imaging.THEMES)[Math.abs(topic.length * 7) % 6], coverPageId: pages[0].id },
    settings: { showPageNumbers: true, includeTitlePage: true },
  });
  pages.forEach((p) => jobs.enqueue(book.id, p.id));
  res.status(201).json({ book: pubBook(book) });
}));

router.get('/books/:id', (req, res) => res.json({ book: pubBook(ownedBook(req)) }));

router.patch('/books/:id', wrap(async (req, res) => {
  const book = ownedBook(req), b = req.body;
  if (b.title !== undefined) { const t = clean(b.title, 80); if (!t) throw new HttpError(400, 'Title cannot be empty.'); book.title = t; }
  if (b.subtitle !== undefined) book.subtitle = clean(b.subtitle, 48);
  if (b.author !== undefined) book.author = clean(b.author, 50);
  if (b.theme?.color !== undefined) { if (!imaging.THEMES[b.theme.color]) throw new HttpError(400, 'Unknown cover colour.'); book.theme.color = b.theme.color; }
  if (b.theme?.coverPageId !== undefined) { if (!book.pages.some((p) => p.id === b.theme.coverPageId)) throw new HttpError(400, 'Unknown cover page.'); book.theme.coverPageId = b.theme.coverPageId; }
  if (b.settings) {
    if (typeof b.settings.showPageNumbers === 'boolean') book.settings.showPageNumbers = b.settings.showPageNumbers;
    if (typeof b.settings.includeTitlePage === 'boolean') book.settings.includeTitlePage = b.settings.includeTitlePage;
  }
  if (b.order !== undefined) {
    const ids = Array.isArray(b.order) ? b.order : [];
    const have = new Set(book.pages.map((p) => p.id));
    if (ids.length !== have.size || !ids.every((i) => have.has(i)) || new Set(ids).size !== ids.length) throw new HttpError(400, 'Invalid page order.');
    book.pages = ids.map((i) => book.pages.find((p) => p.id === i));
  }
  await store.saveBook(book);
  res.json({ book: pubBook(book) });
}));

router.post('/books/:id/duplicate', wrap(async (req, res) => {
  const src = ownedBook(req), plan = planOf(req.user);
  if (store.listBooks(req.user.id).length >= plan.maxBooks) throw new HttpError(402, `The ${plan.name} plan allows ${plan.maxBooks} saved books.`, { code: 'upgrade' });
  const idMap = new Map();
  const pages = src.pages.map((p) => { const np = { ...p, id: store.newId() }; idMap.set(p.id, np.id); return np; });
  const copy = await store.createBook({
    ...JSON.parse(JSON.stringify({ ...src, pages: undefined })), ownerId: req.user.id, title: `Copy of ${src.title}`.slice(0, 80), pages,
    theme: { ...src.theme, coverPageId: idMap.get(src.theme.coverPageId) || pages[0]?.id },
  });
  for (const p of src.pages) if (p.status === 'done') await store.copyPageImage(src.id, p.id, copy.id, idMap.get(p.id));
  res.status(201).json({ book: pubBook(copy) });
}));

router.delete('/books/:id', wrap(async (req, res) => {
  const book = ownedBook(req);
  await store.removeBook(book.id);
  res.json({ ok: true });
}));

// ----- pages -----
router.post('/books/:id/pages', genLimiter, wrap(async (req, res) => {
  const book = ownedBook(req), plan = planOf(req.user);
  const idea = clean(req.body.idea, 200);
  if (idea.length < 2) throw new HttpError(400, 'Describe the picture you want, e.g. "a smiling sun".');
  if (book.pages.length >= plan.maxPagesPerBook) throw new HttpError(402, `The ${plan.name} plan allows up to ${plan.maxPagesPerBook} pages per book.`, { code: 'upgrade' });
  await consume(req.user, 1);
  const page = newPage(idea);
  book.pages.push(page);
  await store.saveBook(book);
  jobs.enqueue(book.id, page.id);
  res.status(201).json({ book: pubBook(book) });
}));

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Upload a JPG, PNG, WebP or GIF image.'))),
});
router.post('/books/:id/pages/upload', genLimiter, upload.single('image'), wrap(async (req, res) => {
  const book = ownedBook(req), plan = planOf(req.user);
  if (!req.file) throw new HttpError(400, 'Choose an image to upload.');
  try { await sharp(req.file.buffer, { limitInputPixels: 80e6 }).metadata(); } catch { throw new HttpError(400, 'That file is not a valid image.'); }
  const mode = req.body.mode === 'asis' ? 'asis' : 'outline';
  let page = req.body.pageId ? book.pages.find((p) => p.id === req.body.pageId) : null;
  if (req.body.pageId && !page) throw new HttpError(404, 'Page not found.');
  if (!page) {
    if (book.pages.length >= plan.maxPagesPerBook) throw new HttpError(402, `The ${plan.name} plan allows up to ${plan.maxPagesPerBook} pages per book.`, { code: 'upgrade' });
    page = newPage(clean(req.body.caption, 200) || 'My uploaded picture', 'upload');
    book.pages.push(page);
  } else page.source = 'upload';
  if (book.pages.filter((p) => p.source === 'upload').length > plan.maxUploadsPerBook) throw new HttpError(402, `The ${plan.name} plan allows ${plan.maxUploadsPerBook} uploaded pictures per book.`, { code: 'upgrade' });
  await store.saveBook(book);
  jobs.enqueue(book.id, page.id, { uploadBuffer: req.file.buffer, mode });
  res.status(201).json({ book: pubBook(book), pageId: page.id });
}));

router.patch('/books/:id/pages/:pid', wrap(async (req, res) => {
  const book = ownedBook(req), page = ownedPage(req, book);
  const idea = clean(req.body.idea, 200);
  if (idea.length < 2) throw new HttpError(400, 'Describe the picture (at least 2 characters).');
  page.idea = idea;
  await store.saveBook(book);
  res.json({ book: pubBook(book) });
}));
router.post('/books/:id/pages/:pid/regenerate', genLimiter, wrap(async (req, res) => {
  const book = ownedBook(req), page = ownedPage(req, book);
  if (page.status === 'pending' || page.status === 'generating') throw new HttpError(409, 'This page is already being drawn.');
  if (req.body?.idea) { const idea = clean(req.body.idea, 200); if (idea.length >= 2) page.idea = idea; }
  if (page.source === 'upload' && !req.body?.idea) throw new HttpError(400, 'Uploaded pictures cannot be regenerated. Upload a new file or describe a new idea.');
  await consume(req.user, 1);
  page.source = 'ai';
  jobs.enqueue(book.id, page.id);
  res.json({ book: pubBook(book) });
}));
router.post('/books/:id/retry-failed', genLimiter, wrap(async (req, res) => {
  const book = ownedBook(req);
  const failed = book.pages.filter((p) => p.status === 'error' && p.source === 'ai');
  if (!failed.length) return res.json({ book: pubBook(book) });
  await consume(req.user, failed.length);
  failed.forEach((p) => jobs.enqueue(book.id, p.id));
  res.json({ book: pubBook(book) });
}));
router.delete('/books/:id/pages/:pid', wrap(async (req, res) => {
  const book = ownedBook(req), page = ownedPage(req, book);
  if (book.pages.length <= 1) throw new HttpError(400, 'A book needs at least one page.');
  book.pages = book.pages.filter((p) => p !== page);
  if (book.theme.coverPageId === page.id) book.theme.coverPageId = book.pages[0].id;
  jobs.settle(book);
  await store.saveBook(book);
  await store.removePageImage(book.id, page.id);
  res.json({ book: pubBook(book) });
}));

// ----- images -----
const WIDTHS = { thumb: 420, preview: 1000 };
function sendPng(res, buf, name, download) {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=86400');
  if (download) res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
}
router.get('/books/:id/pages/:pid/image', wrap(async (req, res) => {
  const book = ownedBook(req), page = ownedPage(req, book);
  if (page.status !== 'done') throw new HttpError(404, 'This page is not ready yet.');
  let buf = await store.readPageImage(book.id, page.id);
  const w = WIDTHS[req.query.size];
  if (w) buf = await imaging.resized(buf, w);
  const idx = book.pages.indexOf(page) + 1;
  sendPng(res, buf, `${slug(book.title)}-page-${String(idx).padStart(2, '0')}.png`, req.query.download === '1');
}));
async function coverBuffer(book, width) {
  const done = book.pages.filter((p) => p.status === 'done');
  const cp = done.find((p) => p.id === book.theme.coverPageId) || done[0];
  return imaging.renderCover(book, cp ? await store.readPageImage(book.id, cp.id) : null, width);
}
router.get('/books/:id/cover', wrap(async (req, res) => {
  const book = ownedBook(req);
  const width = req.query.size === 'full' ? imaging.A4_PX.w : 900;
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'image/png');
  if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="${slug(book.title)}-cover.png"`);
  res.send(await coverBuffer(book, width));
}));
router.get('/books/:id/title-page', wrap(async (req, res) => {
  const book = ownedBook(req);
  res.set('Cache-Control', 'no-store'); res.set('Content-Type', 'image/png');
  res.send(await imaging.renderTitlePage(book, req.query.size === 'full' ? imaging.A4_PX.w : 900));
}));

// ----- exports -----
const needDone = (book) => { if (!book.pages.some((p) => p.status === 'done')) throw new HttpError(409, 'No pages are finished yet.'); };
router.get('/books/:id/pdf', exportLimiter, wrap(async (req, res) => {
  const book = ownedBook(req); needDone(book);
  const bytes = await buildBookPdf(book, planOf(req.user));
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${slug(book.title)}-A4.pdf"`);
  res.set('Cache-Control', 'no-store');
  res.set('X-Skipped-Pages', String(book.pages.filter((p) => p.status !== 'done').length));
  res.send(Buffer.from(bytes));
}));
router.get('/books/:id/images.zip', exportLimiter, wrap(async (req, res) => {
  const book = ownedBook(req); needDone(book);
  const files = { 'cover.png': new Uint8Array(await coverBuffer(book, imaging.A4_PX.w)) };
  let n = 0;
  for (const p of book.pages) if (p.status === 'done') { n += 1; files[`page-${String(n).padStart(2, '0')}.png`] = new Uint8Array(await store.readPageImage(book.id, p.id)); }
  const zip = zipSync(files, { level: 0 });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${slug(book.title)}-images.zip"`);
  res.send(Buffer.from(zip));
}));

// Stripe webhook is mounted separately in index.js (needs the raw body); exported helper below.
async function stripeWebhook(req, res) {
  if (!billing.enabled()) return res.status(503).end();
  const raw = req.body.toString('utf8');
  if (!billing.verifySignature(raw, req.get('stripe-signature'), cfg.stripe.webhookSecret)) return res.status(400).json({ error: 'Bad signature' });
  try { await billing.handleEvent(JSON.parse(raw)); } catch (e) { console.error('webhook error', e); return res.status(500).end(); }
  res.json({ received: true });
}

// ---------- errors ----------
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 10 MB).' : 'Upload failed.' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});
module.exports = { router, stripeWebhook };
