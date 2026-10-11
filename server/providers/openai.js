'use strict';
// Real AI image generation via the OpenAI Images API (or any OpenAI-compatible endpoint).
// The API key lives only in server environment variables.
const cfg = require('../config');

class ProviderError extends Error {
  constructor(message, { code = 'provider_error', retryable = false } = {}) { super(message); this.code = code; this.retryable = retryable; }
}

async function generate({ prompt }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180000);
  let res;
  try {
    res = await fetch(`${cfg.openai.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openai.apiKey}` },
      body: JSON.stringify({ model: cfg.openai.model, prompt, size: cfg.openai.size, quality: cfg.openai.quality, n: 1 }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new ProviderError(e.name === 'AbortError' ? 'The image service timed out.' : 'Could not reach the image service.', { code: 'network', retryable: true });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
    if (res.status === 401 || res.status === 403) throw new ProviderError('The image service rejected the server API key.', { code: 'auth' });
    if (res.status === 429) throw new ProviderError('The image service is busy (rate limit). Retrying usually works.', { code: 'rate_limited', retryable: true });
    if (res.status === 400 && /safety|policy|moderation/i.test(detail)) throw new ProviderError('This idea was blocked by the image safety filter. Try rewording it.', { code: 'content_policy' });
    throw new ProviderError(`Image service error (${res.status}). ${res.status >= 500 ? 'Please retry.' : detail.slice(0, 160)}`, { code: 'upstream', retryable: res.status >= 500 });
  }
  const json = await res.json();
  const item = json?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const r = await fetch(item.url);
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  }
  throw new ProviderError('The image service returned no image.', { code: 'empty', retryable: true });
}
module.exports = { generate, ProviderError };
