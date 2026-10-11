'use strict';
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');

const COOKIE = 'cbs_session';

// ----- passwords (scrypt, per-user random salt) -----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

// ----- signed session cookie: <userId>.<expiryMs>.<hmac> -----
const sign = (payload) => crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');
function makeToken(userId) {
  const payload = `${userId}.${Date.now() + cfg.sessionDays * 864e5}`;
  return `${payload}.${sign(payload)}`;
}
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const a = Buffer.from(sign(payload));
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return parts[0];
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, userId) {
  res.cookie(COOKIE, makeToken(userId), {
    httpOnly: true, sameSite: 'lax', secure: cfg.isProd, maxAge: cfg.sessionDays * 864e5, path: '/',
  });
}
const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

// ----- middleware -----
function loadUser(req, _res, next) {
  const id = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  req.user = id ? store.getUser(id) : undefined;
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}
// CSRF defence for cookie auth: state-changing requests must carry a custom header that
// cross-site forms cannot set (plus SameSite=Lax cookies).
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/billing/webhook') return next(); // authenticated by Stripe signature instead
  if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

module.exports = { hashPassword, verifyPassword, setSession, clearSession, loadUser, requireAuth, csrfGuard, makeToken, readToken };
