'use strict';
const cfg = require('../config');
const prompts = {
  '3-5': 'for toddlers and preschoolers (ages 3-5): ONE large, simple, friendly subject, extra-thick bold outlines, very few big shapes, no tiny details, lots of empty white space to colour',
  '6-8': 'for children aged 6-8: a cheerful scene with a clear main subject, thick clean outlines, moderate detail, a few simple background elements',
  '9-12': 'for children aged 9-12: a detailed scene with medium-weight outlines, interesting patterns and textures, more background elements',
  adult: 'for adults: intricate, elegant, highly detailed illustration with fine lines, ornate patterns and zentangle-style textures, balanced composition',
};
function buildPrompt(idea, age) {
  return [
    `Black-and-white colouring book page ${prompts[age] || prompts['6-8']}.`,
    `Subject: ${idea}.`,
    'Style: clean vector-like line art, uniform black outlines only, PURE WHITE background, no grey tones, no shading, no filled black areas, no text, no letters, no watermark, no border.',
    'Portrait composition, subject centred with a generous white margin on all sides, every shape closed so it is easy to colour in.',
  ].join(' ');
}
async function generate({ idea, age, seed }) {
  if (cfg.provider === 'openai') return require('./openai').generate({ prompt: buildPrompt(idea, age) });
  return require('./demo').generate({ idea, age, seed });
}
module.exports = { generate, buildPrompt, name: cfg.provider };
