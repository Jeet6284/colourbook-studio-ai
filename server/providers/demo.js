'use strict';
// DEMO provider: draws simple vector line-art locally so the whole app (editor, PDF, ZIP, print)
// works without an API key. It is NOT AI - set OPENAI_API_KEY for real AI illustrations.
const sharp = require('sharp');
const { bankKeyFor } = require('../ideas');

const W = 1024, H = 1536;
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const hash = (str) => { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const el = (name, attrs, inner = '') => `<${name} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}${inner ? `>${inner}</${name}>` : '/>'}`;
const deg = (a) => (a * Math.PI) / 180;

function cloud(x, y, s = 1) { return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 60 a40 40 0 0 1 20 -70 a55 55 0 0 1 100 10 a35 35 0 0 1 10 60 Z"/></g>`; }
function sun(x, y, r, rays) {
  let g = el('circle', { cx: x, cy: y, r });
  for (let i = 0; i < rays; i++) { const a = deg((360 / rays) * i); g += el('line', { x1: x + Math.cos(a) * (r + 18), y1: y + Math.sin(a) * (r + 18), x2: x + Math.cos(a) * (r + 60), y2: y + Math.sin(a) * (r + 60) }); }
  return g;
}
function petals(cx, cy, n, len, wid, rot = 0) {
  let g = '';
  for (let i = 0; i < n; i++) g += `<ellipse cx="${cx}" cy="${cy - len}" rx="${wid}" ry="${len}" transform="rotate(${rot + (360 / n) * i} ${cx} ${cy})"/>`;
  return g;
}
function flowerHead(cx, cy, size, detail, r) {
  const n = 5 + Math.floor(r() * 4);
  let g = petals(cx, cy, n, size, size * 0.42) + el('circle', { cx, cy, r: size * 0.45 });
  if (detail > 1) { g += petals(cx, cy, n, size * 0.55, size * 0.18, 180 / n); g += el('circle', { cx, cy, r: size * 0.22 }); }
  return g;
}
const stem = (x, y1, y2) => `<path d="M${x} ${y1} C${x - 30} ${(y1 + y2) / 2} ${x + 30} ${(y1 + y2) / 2 + 40} ${x} ${y2}" fill="none"/>`;
const leaf = (x, y, dir, s = 1) => `<path d="M${x} ${y} q${60 * dir * s} -90 ${130 * dir * s} -40 q${-40 * dir * s} 80 ${-130 * dir * s} 40 Z"/>`;

const GEN = {
  flowers(r, d) {
    let g = cloud(120, 160, 1.1) + sun(860, 190, 70, 10 + d * 2);
    const n = d > 1 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const cx = n === 1 ? 512 : 220 + i * 290, top = n === 1 ? 640 : 760 + (i % 2) * 120, s = n === 1 ? 230 : 120;
      g += stem(cx, top + s, 1380) + leaf(cx, 1150, i % 2 ? -1 : 1, 1.2) + flowerHead(cx, top, s, d, r);
    }
    return g + `<path d="M60 1400 Q512 1340 964 1400" fill="none"/>`;
  },
  butterfly(r, d) {
    const wing = (m) => `<g transform="translate(512 760) scale(${m} 1)"><path d="M20 -20 C150 -330 440 -330 420 -120 C410 20 200 40 20 10 Z"/><path d="M20 30 C170 40 330 100 300 280 C270 410 100 330 20 60 Z"/>${el('circle', { cx: 230, cy: -140, r: 70 })}${el('circle', { cx: 170, cy: 190, r: 45 })}${d > 1 ? el('circle', { cx: 330, cy: -60, r: 30 }) + el('circle', { cx: 250, cy: 120, r: 22 }) : ''}</g>`;
    return wing(1) + wing(-1) + el('ellipse', { cx: 512, cy: 790, rx: 26, ry: 190 }) + `<path d="M500 600 C460 520 420 490 390 500 M524 600 C564 520 604 490 634 500" fill="none"/>` + el('circle', { cx: 512, cy: 590, r: 34 });
  },
  fish(r, d) {
    let g = `<g transform="translate(0 100)">`;
    g += el('ellipse', { cx: 470, cy: 700, rx: 330, ry: 230 }) + `<path d="M790 700 L960 520 Q930 700 960 880 Z"/>` + `<path d="M400 480 Q470 360 590 480 Z"/><path d="M420 900 Q480 1020 570 900 Z"/>` + el('circle', { cx: 270, cy: 650, r: 38 }) + el('circle', { cx: 270, cy: 650, r: 12 }) + `<path d="M180 760 Q215 800 260 780" fill="none"/>`;
    if (d > 0) for (let row = 0; row < 3 + d; row++) for (let c = 0; c < 3; c++) g += `<path d="M${430 + c * 90 + (row % 2) * 45} ${640 + row * 60} q40 40 0 80" fill="none"/>`;
    g += `</g>`;
    for (let i = 0; i < 4 + d; i++) g += el('circle', { cx: 120 + r() * 700, cy: 120 + r() * 300, r: 14 + r() * 26 });
    g += `<path d="M120 1450 q-40 -150 10 -280 M200 1450 q50 -120 -20 -230 M900 1450 q-40 -150 10 -280" fill="none"/>`;
    return g;
  },
  vehicles(r, d) {
    let g = cloud(100, 150, 1.2) + sun(850, 200, 70, 10);
    g += `<path d="M110 1010 V860 Q110 820 160 810 L330 790 L430 620 Q450 590 490 590 H720 Q760 590 790 630 L890 790 L930 810 Q960 830 960 870 V1010 Z"/>`;
    g += `<path d="M370 770 L450 650 H600 V770 Z M640 770 V650 H720 L810 770 Z"/>`;
    for (const x of [300, 760]) g += el('circle', { cx: x, cy: 1010, r: 105 }) + el('circle', { cx: x, cy: 1010, r: 48 }) + (d > 1 ? petals(x, 1010, 6, 38, 10) : '');
    g += el('circle', { cx: 910, cy: 880, r: 30 }) + `<path d="M130 1140 H900" fill="none" stroke-dasharray="40 30"/>` + `<path d="M60 1200 H964" fill="none"/>`;
    return g;
  },
  dinosaurs(r, d) {
    let g = cloud(640, 150, 1) + sun(130, 180, 60, 9);
    g += `<path d="M180 980 C150 1010 90 1030 60 1020 C110 960 160 930 200 900" />`; // tail
    g += el('ellipse', { cx: 470, cy: 880, rx: 300, ry: 190 });
    g += `<path d="M640 800 C720 700 700 520 760 440 C800 380 900 400 910 470 C920 520 880 560 840 560 C800 610 800 700 760 840 Z"/>`;
    g += el('circle', { cx: 842, cy: 460, r: 18 }) + `<path d="M880 520 q20 -10 30 -30" fill="none"/>`;
    for (let i = 0; i < 4; i++) g += `<path d="M${330 + i * 90} 705 l25 -75 l25 75" />`;
    for (const x of [330, 600]) g += `<path d="M${x} 1000 v190 h90 v-190" />`;
    if (d > 0) for (let i = 0; i < 5; i++) g += el('circle', { cx: 330 + i * 60, cy: 850 + (i % 2) * 60, r: 14 });
    g += `<path d="M40 1260 Q512 1200 984 1260" fill="none"/>`;
    return g;
  },
  animals(r, d, idea) {
    const dog = /dog|puppy|fox/.test(idea), bear = /bear|panda|monkey|lion|elephant/.test(idea), rabbit = /rabbit/.test(idea);
    let g = '';
    if (rabbit) g += el('ellipse', { cx: 390, cy: 360, rx: 70, ry: 230 }) + el('ellipse', { cx: 640, cy: 360, rx: 70, ry: 230 });
    else if (bear) g += el('circle', { cx: 290, cy: 420, r: 100 }) + el('circle', { cx: 740, cy: 420, r: 100 });
    else if (dog) g += `<path d="M260 480 C170 540 170 780 270 840 C320 760 330 600 340 480 Z"/><path d="M760 480 C850 540 850 780 750 840 C700 760 690 600 680 480 Z"/>`;
    else g += `<path d="M260 560 L240 290 L450 440 Z"/><path d="M770 560 L790 290 L580 440 Z"/>`;
    g += el('circle', { cx: 512, cy: 640, r: 280 }) + el('circle', { cx: 400, cy: 590, r: 40 }) + el('circle', { cx: 630, cy: 590, r: 40 }) + el('circle', { cx: 410, cy: 580, r: 14 }) + el('circle', { cx: 640, cy: 580, r: 14 });
    g += `<path d="M470 690 H555 L512 740 Z"/><path d="M512 740 V790 M440 810 Q512 870 585 810" fill="none"/>`;
    if (!dog) g += `<path d="M300 720 L130 690 M300 770 L130 790 M720 720 L890 690 M720 770 L890 790" fill="none"/>`;
    g += `<path d="M330 900 Q512 1000 700 900 L760 1250 Q512 1320 270 1250 Z"/>`;
    if (d > 1) for (let i = 0; i < 6; i++) g += el('circle', { cx: 380 + i * 50, cy: 1080 + (i % 2) * 70, r: 16 });
    return g;
  },
  birds(r, d) {
    let g = `<path d="M60 1000 Q512 930 964 1000" fill="none"/>` + leaf(190, 1000, 1, 1.3) + leaf(860, 990, -1, 1.2);
    g += el('ellipse', { cx: 500, cy: 720, rx: 250, ry: 190 }) + el('circle', { cx: 710, cy: 560, r: 120 });
    g += `<path d="M810 540 L930 590 L810 625 Z"/>` + el('circle', { cx: 720, cy: 530, r: 18 });
    g += `<path d="M260 700 L90 610 L110 800 Z"/>` + `<path d="M400 690 C470 560 600 560 650 700 C560 800 450 800 400 690 Z"/>`;
    g += `<path d="M440 890 v110 M560 890 v110" />` + sun(150, 200, 60, 10) + cloud(600, 150, 1);
    if (d > 1) g += petals(530, 700, 7, 50, 14);
    return g;
  },
  space(r, d) {
    let g = `<path d="M512 200 C640 340 680 560 650 900 H374 C344 560 384 340 512 200 Z"/>` + el('circle', { cx: 512, cy: 520, r: 70 }) + el('circle', { cx: 512, cy: 520, r: 42 });
    g += `<path d="M374 760 L230 980 L374 930 Z M650 760 L794 980 L650 930 Z"/><path d="M430 900 Q512 1260 594 900 Z"/><path d="M470 920 Q512 1100 554 920" fill="none"/>`;
    for (let i = 0; i < 6 + d * 3; i++) { const x = 70 + r() * 880, y = 80 + r() * 1300; if (x > 330 && x < 700 && y > 150 && y < 1200) continue; g += `<path d="M${x} ${y - 28} l8 20 l20 8 l-20 8 l-8 20 l-8 -20 l-20 -8 l20 -8 Z"/>`; }
    g += el('circle', { cx: 860, cy: 1180, r: 110 }) + `<ellipse cx="860" cy="1180" rx="170" ry="34" fill="none" transform="rotate(-18 860 1180)"/>`;
    return g;
  },
  cartoon(r, d) {
    let g = `<path d="M512 240 V150" fill="none"/>` + el('circle', { cx: 512, cy: 135, r: 28 });
    g += `<rect x="290" y="250" width="444" height="380" rx="90"/>` + el('circle', { cx: 410, cy: 400, r: 62 }) + el('circle', { cx: 614, cy: 400, r: 62 }) + el('circle', { cx: 410, cy: 400, r: 22 }) + el('circle', { cx: 614, cy: 400, r: 22 });
    g += `<path d="M390 520 Q512 610 634 520" fill="none"/><rect x="330" y="680" width="364" height="440" rx="70"/><rect x="430" y="780" width="164" height="150" rx="30"/>`;
    g += `<path d="M330 760 L180 900 L210 960 L350 860 M694 760 L844 900 L814 960 L674 860" /><rect x="360" y="1120" width="110" height="200" rx="30"/><rect x="554" y="1120" width="110" height="200" rx="30"/>`;
    if (d > 1) for (let i = 0; i < 3; i++) g += el('circle', { cx: 470 + i * 42, cy: 1010, r: 14 });
    return g;
  },
  patterns(r, d, _i, extra = 0) {
    let g = '';
    const rings = 3 + d + extra, base = 120 + 380 / rings;
    for (let k = rings; k >= 1; k--) {
      const rad = (k / rings) * 440, n = 6 + k * 2 + (d > 2 ? 4 : 0);
      g += el('circle', { cx: 512, cy: 768, r: rad });
      for (let i = 0; i < n; i++) g += `<ellipse cx="512" cy="${768 - rad * 0.72}" rx="${Math.max(10, rad * 0.14)}" ry="${Math.max(16, rad * 0.26)}" transform="rotate(${(360 / n) * i + (k % 2 ? 180 / n : 0)} 512 768)"/>`;
    }
    return g + el('circle', { cx: 512, cy: 768, r: 36 }) + (base ? '' : '');
  },
  scene(r, d) {
    let g = sun(850, 200, 80, 12) + cloud(120, 170, 1.2);
    g += `<rect x="260" y="640" width="460" height="400"/><path d="M220 650 L490 420 L760 650 Z"/><rect x="450" y="820" width="120" height="220"/><rect x="310" y="720" width="100" height="90"/><rect x="600" y="720" width="80" height="90"/>`;
    g += `<path d="M830 1040 V760" fill="none"/>` + el('circle', { cx: 830, cy: 700, r: 100 }) + `<path d="M40 1040 H984" fill="none"/>`;
    if (d > 1) g += flowerHead(160, 960, 50, 1, r) + flowerHead(100, 1100, 40, 1, r);
    return g;
  },
};

function pick(idea, seedKey) {
  const t = idea.toLowerCase();
  const rules = [[/butterfl/, 'butterfly'], [/fish|dolphin|whale|shark|octopus|seahorse|jelly|crab|turtle|ocean|sea\b/, 'fish'], [/dinosaur|dino|rex|saurus|raptor|pterod/, 'dinosaurs'], [/car|truck|bus|train|vehicle|tractor|motorbike|ambulance|bulldozer/, 'vehicles'], [/rocket|space|planet|astronaut|alien|comet|moon|satellite/, 'space'], [/mandala|pattern|snowflake|lace|paisley|geometric/, 'patterns'], [/robot|monster|knight|princess|wizard|pirate|superhero|dragon|ghost|unicorn|fairy|snowman|cartoon|mermaid/, 'cartoon'], [/bird|parrot|owl|duck|flamingo|peacock|penguin|eagle|swan|chick|toucan|robin/, 'birds'], [/flower|rose|tulip|daisy|lotus|sunflower|poppy|lily|lavender|garden|plant/, 'flowers'], [/lion|elephant|puppy|dog|kitten|cat|giraffe|monkey|panda|tortoise|rabbit|fox|zebra|kangaroo|bear|hedgehog|cow|horse|pig/, 'animals']];
  for (const [re, g] of rules) if (re.test(t)) return g;
  const key = bankKeyFor(idea);
  if (key && GEN[key === 'vehicles' ? 'vehicles' : key]) return key;
  return 'scene';
}

// Per-idea variation so repeated subjects do not look identical: mirror + slight scale/shift.
function variation(r) {
  const flip = r() > 0.5 ? -1 : 1, sc = 0.82 + r() * 0.16, dx = (r() - 0.5) * 60, dy = (r() - 0.5) * 90;
  return `translate(${W / 2 + dx} ${H / 2 + dy}) scale(${flip * sc} ${sc}) translate(${-W / 2} ${-H / 2})`;
}

async function generate({ idea, age, seed }) {
  const r = rng(hash(idea + (seed || '')));
  const kind = pick(idea, seed);
  const detail = { '3-5': 0, '6-8': 1, '9-12': 2, adult: 3 }[age] ?? 1;
  const stroke = [16, 12, 8, 5][detail];
  const body = kind === 'patterns' || age === 'adult' && kind === 'scene' ? GEN.patterns(r, detail, idea, detail > 2 ? 2 : 0) : GEN[kind](r, detail, idea.toLowerCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/><g transform="${variation(r)}"><g fill="#fff" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round">${body}</g></g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
module.exports = { generate };
