'use strict';
// Stripe Checkout (subscription) + webhook. Disabled until STRIPE_* variables are set.
// UNTESTED against live Stripe in this repo's test-suite - only signature verification is unit-tested.
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');

const enabled = () => Boolean(cfg.stripe.secretKey && cfg.stripe.priceId && cfg.stripe.webhookSecret);
const origin = (req) => cfg.publicUrl || `${req.protocol}://${req.get('host')}`;

async function stripe(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || 'Stripe request failed');
  return json;
}
async function createCheckout(req, user) {
  const params = {
    mode: 'subscription',
    'line_items[0][price]': cfg.stripe.priceId,
    'line_items[0][quantity]': '1',
    success_url: `${origin(req)}/#/settings?upgraded=1`,
    cancel_url: `${origin(req)}/#/settings`,
    client_reference_id: user.id,
  };
  if (user.stripeCustomerId) params.customer = user.stripeCustomerId; else params.customer_email = user.email;
  return (await stripe('checkout/sessions', params)).url;
}
async function createPortal(req, user) {
  return (await stripe('billing_portal/sessions', { customer: user.stripeCustomerId, return_url: `${origin(req)}/#/settings` })).url;
}
// Stripe-Signature: t=<unix>,v1=<hmac_sha256(t + "." + rawBody)>
function verifySignature(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function handleEvent(evt) {
  const obj = evt.data?.object || {};
  if (evt.type === 'checkout.session.completed' && obj.client_reference_id) {
    await store.updateUser(obj.client_reference_id, { plan: 'premium', stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription });
  } else if (evt.type === 'customer.subscription.deleted') {
    const u = store.findUserByStripeCustomer(obj.customer);
    if (u) await store.updateUser(u.id, { plan: 'free' });
  }
}
module.exports = { enabled, createCheckout, createPortal, verifySignature, handleEvent };
