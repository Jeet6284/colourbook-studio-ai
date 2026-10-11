'use strict';
// Small file-based store: users.json + one folder per book (book.json and page PNGs).
// Writes are atomic (write temp file, then rename) and serialised per file.
// For multi-instance deployments swap this module for Postgres + S3 (same function surface).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./config');

const usersFile = path.join(dataDir, 'users.json');
const booksDir = path.join(dataDir, 'books');
fs.mkdirSync(booksDir, { recursive: true });

const ID_RE = /^[a-f0-9]{24}$/;
const newId = () => crypto.randomBytes(12).toString('hex');
const isId = (s) => typeof s === 'string' && ID_RE.test(s);

const chains = new Map();
function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

// ---------- users ----------
let users = {};
try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { users = {}; }
const saveUsers = () => serial(usersFile, () => writeAtomic(usersFile, JSON.stringify(users)));

const normEmail = (e) => String(e || '').trim().toLowerCase();
const findUserByEmail = (email) => Object.values(users).find((u) => u.email === normEmail(email));
const getUser = (id) => users[id];
async function createUser(u) {
  const user = { id: newId(), createdAt: Date.now(), plan: 'free', usage: { day: '', generations: 0 }, ...u, email: normEmail(u.email) };
  users[user.id] = user;
  await saveUsers();
  return user;
}
async function updateUser(id, patch) {
  if (!users[id]) return null;
  Object.assign(users[id], patch);
  await saveUsers();
  return users[id];
}
const findUserByStripeCustomer = (cid) => Object.values(users).find((u) => cid && u.stripeCustomerId === cid);
async function deleteUser(id) {
  delete users[id];
  await saveUsers();
}

// ---------- books ----------
const books = new Map(); // id -> book (in memory cache, persisted to disk)
for (const id of fs.existsSync(booksDir) ? fs.readdirSync(booksDir) : []) {
  if (!isId(id)) continue;
  try {
    const b = JSON.parse(fs.readFileSync(path.join(booksDir, id, 'book.json'), 'utf8'));
    // A restart interrupts running generations: surface those pages as retryable errors.
    for (const p of b.pages) if (p.status === 'generating' || p.status === 'pending') { p.status = 'error'; p.error = 'Generation was interrupted. Tap retry.'; }
    books.set(id, b);
  } catch { /* skip corrupt */ }
}
const bookDir = (id) => path.join(booksDir, id);
const pagePath = (bookId, pageId) => path.join(bookDir(bookId), 'pages', `${pageId}.png`);
const saveBook = (book) => {
  book.updatedAt = Date.now();
  return serial(`book:${book.id}`, async () => {
    await fsp.mkdir(bookDir(book.id), { recursive: true });
    await writeAtomic(path.join(bookDir(book.id), 'book.json'), JSON.stringify(book));
  });
};
async function createBook(book) {
  book.id = newId();
  book.createdAt = Date.now();
  books.set(book.id, book);
  await fsp.mkdir(path.join(bookDir(book.id), 'pages'), { recursive: true });
  await saveBook(book);
  return book;
}
const getBook = (id) => (isId(id) ? books.get(id) : undefined);
const listBooks = (ownerId) => [...books.values()].filter((b) => b.ownerId === ownerId).sort((a, b) => b.updatedAt - a.updatedAt);
async function removeBook(id) {
  books.delete(id);
  await fsp.rm(bookDir(id), { recursive: true, force: true });
}
async function writePageImage(bookId, pageId, buf) {
  await fsp.mkdir(path.join(bookDir(bookId), 'pages'), { recursive: true });
  await writeAtomic(pagePath(bookId, pageId), buf);
}
const readPageImage = (bookId, pageId) => fsp.readFile(pagePath(bookId, pageId));
const removePageImage = (bookId, pageId) => fsp.rm(pagePath(bookId, pageId), { force: true });
async function copyPageImage(fromBook, fromPage, toBook, toPage) {
  await fsp.mkdir(path.join(bookDir(toBook), 'pages'), { recursive: true });
  await fsp.copyFile(pagePath(fromBook, fromPage), pagePath(toBook, toPage));
}

module.exports = {
  newId, isId, normEmail,
  findUserByEmail, getUser, createUser, updateUser, findUserByStripeCustomer, deleteUser,
  createBook, getBook, listBooks, saveBook, removeBook, writePageImage, readPageImage, removePageImage, copyPageImage,
};
