'use strict';
// Central configuration. Secrets are read ONLY from environment variables (or a local .env file),
// never from frontend code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(__dirname, '..', '.env'));

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Session secret: required in production; auto-generated (and persisted) for local development.
let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) throw new Error('SESSION_SECRET must be set in production (use a long random string).');
  const f = path.join(DATA_DIR, '.dev-session-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  sessionSecret = fs.readFileSync(f, 'utf8');
}

const provider = (env.IMAGE_PROVIDER || (env.OPENAI_API_KEY ? 'openai' : 'demo')).toLowerCase();
if (provider === 'openai' && !env.OPENAI_API_KEY) throw new Error('IMAGE_PROVIDER=openai requires OPENAI_API_KEY.');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

module.exports = {
  isProd,
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  dataDir: DATA_DIR,
  sessionSecret,
  sessionDays: 30,
  provider,
  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    quality: env.OPENAI_IMAGE_QUALITY || 'medium',
    size: env.OPENAI_IMAGE_SIZE || '1024x1536',
  },
  genConcurrency: num(env.GEN_CONCURRENCY, provider === 'openai' ? 3 : 4),
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    priceId: env.STRIPE_PRICE_ID || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  // Only for local testing: lets the Settings screen flip the plan without a payment. Never enable in production.
  devPlanSwitch: env.ALLOW_DEV_PLAN_SWITCH === 'true' && !isProd,
  signupsOpen: env.SIGNUPS_OPEN !== 'false',
  plans: {
    free: {
      id: 'free', name: 'Free', maxPagesPerBook: 10, maxBooks: 3, dailyGenerations: num(env.FREE_DAILY_GENERATIONS, 30),
      maxUploadsPerBook: 3, footer: true,
    },
    premium: {
      id: 'premium', name: 'Premium', maxPagesPerBook: 50, maxBooks: 200, dailyGenerations: num(env.PREMIUM_DAILY_GENERATIONS, 300),
      maxUploadsPerBook: 50, footer: false,
    },
  },
  pageOptions: [10, 20, 30, 50],
  ageGroups: [
    { id: '3-5', label: 'Ages 3–5' },
    { id: '6-8', label: 'Ages 6–8' },
    { id: '9-12', label: 'Ages 9–12' },
    { id: 'adult', label: 'Adults' },
  ],
  categories: [
    { id: 'animals', label: 'Animals', topic: 'animals' },
    { id: 'birds', label: 'Birds', topic: 'birds' },
    { id: 'flowers', label: 'Flowers', topic: 'flowers' },
    { id: 'dinosaurs', label: 'Dinosaurs', topic: 'dinosaurs' },
    { id: 'cars', label: 'Cars & Vehicles', topic: 'cars and vehicles' },
    { id: 'cartoon', label: 'Cartoon Characters', topic: 'cartoon-style characters' },
    { id: 'ocean', label: 'Ocean Life', topic: 'ocean animals' },
    { id: 'space', label: 'Space', topic: 'space and rockets' },
    { id: 'patterns', label: 'Patterns & Mandalas', topic: 'mandala patterns' },
  ],
};
