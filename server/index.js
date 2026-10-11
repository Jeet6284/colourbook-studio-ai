'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cfg = require('./config');
const auth = require('./auth');
const { router, stripeWebhook } = require('./api');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY || cfg.isProd) app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.use(helmet({
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: cfg.isProd ? [] : null, defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"], fontSrc: ["'self'", 'https://fonts.gstatic.com'], scriptSrc: ["'self'"], objectSrc: ["'self'"], frameSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], frameAncestors: ["'self'"] } },
    crossOriginEmbedderPolicy: false,
  }));
  app.get('/healthz', (_req, res) => res.json({ ok: true, provider: cfg.provider }));
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), stripeWebhook);
  // Android (Trusted Web Activity / APK) ownership proof - set ANDROID_PACKAGE and ANDROID_SHA256 (comma-separated) after signing the APK.
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const pkg = process.env.ANDROID_PACKAGE, fps = (process.env.ANDROID_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!pkg || !fps.length) return res.status(404).json({ error: 'Android app link not configured' });
    res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }]);
  });
  app.get('/sw.js', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.type('js').sendFile(path.join(__dirname, '..', 'public', 'sw.js')); });
  app.use('/api', express.json({ limit: '100kb' }), auth.loadUser, auth.csrfGuard, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, router);
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: cfg.isProd ? '1h' : 0 }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}
module.exports = { createApp };
if (require.main === module) {
  createApp().listen(cfg.port, () => console.log(`ColourBook Studio AI on :${cfg.port}  (image provider: ${cfg.provider})`));
}
