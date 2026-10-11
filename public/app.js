'use strict';
/* ColourBook Studio AI - single-page frontend (no build step). All AI/PDF work happens on the server. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { cfg: null, me: null, plan: null, usage: null, books: [], book: null, lb: null, poll: null, busy: new Set(), ts: Date.now() };
const ICON = {
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>', plus: '<path d="M12 5v14M5 12h14"/>', folder: '<path d="M3 7h6l2 2h10v10H3z"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>', redo: '<path d="M20 5v6h-6M4 19v-6h6"/><path d="M5.5 9A8 8 0 0118 6l2 5M18.5 15A8 8 0 016 18l-2-5"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', img: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>', dl: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', next: '<path d="M9 5l7 7-7 7"/>', prev: '<path d="M15 5l-7 7 7 7"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

// ---------- API ----------
async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); } catch { throw new Error('You seem to be offline. Check your connection and try again.'); }
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
  return data;
}
async function downloadFile(url, fallback) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) { let m = 'Download failed.'; try { m = (await res.json()).error || m; } catch { /* */ } throw new Error(m); }
  const blob = await res.blob();
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallback;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { name, size: blob.size, skipped: Number(res.headers.get('x-skipped-pages') || 0) };
}
function toast(msg, type = 'ok', action) {
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : ''}`;
  el.innerHTML = `<span class="grow">${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) $('button', el).onclick = () => { el.remove(); action.fn(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 9000 : 5000);
}
const fail = (e, retry) => {
  if (e.status === 401) { S.me = null; return route(); }
  toast(e.message, 'err', retry ? { label: 'Retry', fn: retry } : null);
};
const sizeMB = (n) => (n / 1048576).toFixed(1) + ' MB';

// ---------- modal helpers ----------
const okValue = (ov) => { const ins = $$('input', ov); return ins.length > 1 ? Object.fromEntries(ins.map((i) => [i.id, i.value])) : (ins[0] ? ins[0].value : true); };
function modal(html) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = `<div class="modal">${html}</div>`;
    const close = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); const b = e.target.closest('[data-m]'); if (b) close(b.dataset.m === 'ok' ? okValue(ov) : null); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && e.target.tagName === 'INPUT') close(okValue(ov)); });
    document.body.appendChild(ov);
    ($('input', ov) || $('[data-m=ok]', ov))?.focus();
  });
}
const confirmBox = (title, msg, ok = 'Yes', danger = false) => modal(`<h2>${esc(title)}</h2><p class="mut">${esc(msg)}</p><div class="row"><button class="btn ${danger ? 'd' : 'p'} grow" data-m="ok">${esc(ok)}</button><button class="btn grow" data-m="no">Cancel</button></div>`);
const promptBox = (title, value = '', type = 'text', label = '') => modal(`<h2>${esc(title)}</h2><label class="f">${esc(label)}<input type="${type}" value="${esc(value)}" maxlength="80" autocomplete="off"></label><div class="row"><button class="btn p grow" data-m="ok">Save</button><button class="btn grow" data-m="no">Cancel</button></div>`);

// ---------- router ----------
function parseRoute() {
  const [path, q] = (location.hash.replace(/^#/, '') || '/home').split('?');
  return { seg: path.split('/').filter(Boolean), params: Object.fromEntries(new URLSearchParams(q || '')) };
}
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
let routeToken = 0;
async function route() {
  const token = ++routeToken;
  clearInterval(S.poll); S.poll = null;
  try {
    if (!S.cfg) S.cfg = await api('GET', '/api/config');
    if (!S.me) {
      try { Object.assign(S, { me: null }, await meLoad()); } catch { S.me = null; }
    }
    if (token !== routeToken) return;
    const { seg, params } = parseRoute();
    S.r = { seg, params };
    if (!S.me) return render(authScreen());
    const [a, id, sub] = seg;
    if (a === 'book' && id) {
      if (!S.book || S.book.id !== id) { S.book = null; render('<main><div class="empty"><div class="spin"></div><p>Loading your book…</p></div></main>'); S.book = (await api('GET', `/api/books/${id}`)).book; }
      if (token !== routeToken) return;
      render(bookScreen(sub || 'gallery'));
      if (S.book.status === 'generating') startPoll();
      return;
    }
    S.book = null;
    if (a === 'books') { S.books = (await api('GET', '/api/books')).books; return render(libraryScreen()); }
    if (a === 'categories') return render(categoriesScreen());
    if (a === 'create') return render(createScreen(params));
    if (a === 'settings') { await refreshMe(); return render(settingsScreen()); }
    S.books = (await api('GET', '/api/books')).books; await refreshMe();
    render(homeScreen());
  } catch (e) {
    if (e.status === 404 && S.r?.seg[0] === 'book') { toast('That book was not found.', 'err'); return go('#/books'); }
    if (e.status === 401) { S.me = null; return render(authScreen()); }
    render(`<main><div class="card empty"><h2>Something went wrong</h2><p class="mut">${esc(e.message)}</p><button class="btn p" data-act="reload">Try again</button></div></main>`);
  }
}
async function meLoad() { const d = await api('GET', '/api/me'); return { me: d.user, plan: d.plan, usage: d.usage }; }
async function refreshMe() { try { Object.assign(S, await meLoad()); } catch { /* ignore */ } }

function startPoll() {
  clearInterval(S.poll);
  S.poll = setInterval(async () => {
    if (!S.book || S.r?.seg[0] !== 'book') return clearInterval(S.poll);
    try {
      const b = (await api('GET', `/api/books/${S.book.id}`)).book;
      const sig = (x) => x.status + x.pages.map((p) => p.id + p.status + p.version + p.idea).join();
      const changed = sig(b) !== sig(S.book);
      S.book = b;
      if (changed && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) && !$('.overlay')) { const y = scrollY; render(bookScreen(S.r.seg[2] || 'gallery')); scrollTo(0, y); }
      if (b.status !== 'generating') { clearInterval(S.poll); refreshMe(); }
    } catch { /* transient */ }
  }, 1500);
}

// ---------- shell ----------
function shell(inner, active) {
  const nav = [['home', '#/home', 'Home', 'home'], ['create', '#/categories', 'Create', 'plus'], ['books', '#/books', 'My Books', 'folder'], ['settings', '#/settings', 'Settings', 'gear']];
  return `<header class="hdr"><a class="logo" href="#/home"><img src="/icons/icon-192.png" alt="">ColourBook Studio AI</a>
  <nav class="dnav" aria-label="Main">${nav.map((n) => `<a href="${n[1]}" class="${active === n[0] ? 'on' : ''}">${n[2]}</a>`).join('')}</nav></header>
  ${inner}
  <nav class="tabbar" aria-label="Main">${nav.map((n) => `<a href="${n[1]}" class="${active === n[0] ? 'on' : ''}" ${active === n[0] ? 'aria-current="page"' : ''}>${icon(n[3])}${n[2]}</a>`).join('')}</nav>`;
}
function render(html) { $('#app').innerHTML = html; document.title = 'ColourBook Studio AI'; }
const demoBanner = () => (S.cfg.demo ? `<div class="banner tint-s card" style="padding:12px 16px"><b>Demo mode:</b> pictures are simple built-in drawings, not AI. The server owner can enable real AI illustrations by setting <code>OPENAI_API_KEY</code>.</div>` : '');
const thumb = (b, p) => `/api/books/${b.id}/pages/${p.id}/image?size=thumb&v=${p.version}`;
const badge = (p) => ({ done: '', pending: '<span class="chip warn">Queued</span>', generating: '<span class="chip warn">Drawing…</span>', error: '<span class="chip err">Failed</span>' }[p.status]);
const AGE = (id) => S.cfg.ageGroups.find((a) => a.id === id)?.label || id;

// ---------- auth ----------
function authScreen() {
  const mode = S.r?.params?.mode === 'signup' ? 'signup' : 'login';
  return `<div class="auth"><a class="logo" href="#/home" style="justify-content:center;font-size:28px"><img src="/icons/icon-192.png" alt="" style="width:52px;height:52px">ColourBook Studio AI</a>
  <p class="mut" style="text-align:center">Make printable colouring books for kids and adults in minutes.</p>
  ${demoBanner()}
  <div class="card"><div class="opts" style="margin-bottom:14px" role="tablist">
    <a class="btn sm ${mode === 'login' ? 'p' : ''}" href="#/login">Sign in</a><a class="btn sm ${mode === 'signup' ? 'p' : ''}" href="#/login?mode=signup">Create account</a></div>
  <form data-form="${mode}" class="grid" novalidate>
    ${mode === 'signup' ? '<label class="f">Your name<input type="text" name="name" autocomplete="name" maxlength="60"></label>' : ''}
    <label class="f">Email<input type="email" name="email" autocomplete="email" required></label>
    <label class="f">Password${mode === 'signup' ? ' (8+ characters)' : ''}<input type="password" name="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></label>
    <p class="err-msg" role="alert" style="color:var(--bad);font-weight:700"></p>
    <button class="btn p block" type="submit">${mode === 'signup' ? 'Create free account' : 'Sign in'}</button></form></div></div>`;
}

// ---------- 1. home ----------
function homeScreen() {
  const recent = S.books.slice(0, 3);
  const u = S.usage;
  return shell(`<main>
    <div><p class="mut">Welcome back</p><h1>Hi ${esc(S.me.name.split(' ')[0])}! What shall we colour today?</h1></div>
    ${demoBanner()}
    <div class="hero"><h2>Make a new colouring book</h2><p style="opacity:.92">Pick a topic, choose pages and age group, and AI draws every page. Then download a print-ready A4 PDF.</p>
      <div class="row"><a class="btn y" href="#/categories">Create a book</a><a class="btn" href="#/create">Type your own topic</a></div></div>
    <div class="grid g3">
      <div class="card tint-v"><h2>${S.books.length}</h2><p class="mut sm-t" style="color:var(--ink)">Saved books</p></div>
      <div class="card tint-k"><h2>${u.generationsToday}/${u.generationsLimit}</h2><p class="sm-t" >Pictures drawn today</p></div>
      <div class="card tint-m"><h2>${esc(S.plan.name)}</h2><p class="sm-t">Your plan · <a href="#/settings">manage</a></p></div></div>
    <div class="row" style="justify-content:space-between"><h2>Popular topics</h2><a href="#/categories">See all</a></div>
    <div class="grid g3">${S.cfg.categories.slice(0, 4).map((c, i) => catTile(c, i)).join('')}</div>
    <div class="row" style="justify-content:space-between"><h2>Continue where you left off</h2>${S.books.length ? '<a href="#/books">All books</a>' : ''}</div>
    ${recent.length ? `<div class="grid g3">${recent.map(bookCard).join('')}</div>` : '<div class="card empty"><p class="mut">No books yet. Your first one is a few taps away!</p><a class="btn p" href="#/categories">Create my first book</a></div>'}
  </main>`, 'home');
}
const TINTS = ['tint-c', 'tint-m', 'tint-k', 'tint-s', 'tint-v'];
const catTile = (c, i) => `<a class="tile ${TINTS[i % 5]}" href="#/create?topic=${encodeURIComponent(c.topic)}"><i>${esc(c.label[0])}</i>${esc(c.label)}</a>`;
function bookCard(b) {
  const img = b.thumbPageId ? `<img src="/api/books/${b.id}/pages/${b.thumbPageId}/image?size=thumb&v=${b.thumbVersion}" alt="">` : '<div class="spin"></div>';
  const st = b.status === 'generating' ? '<span class="chip warn">Drawing…</span>' : b.status === 'partial' ? '<span class="chip err">Needs retry</span>' : '<span class="chip ok">Ready</span>';
  return `<a class="pg" href="#/book/${b.id}/${b.status === 'generating' ? 'generate' : 'editor'}" style="text-decoration:none;color:inherit"><div class="im">${img}</div><div class="cap"><div class="b">${esc(b.title)}</div><div class="mut sm-t">${b.donePages}/${b.pageCount} pages · ${esc(AGE(b.ageGroup))}</div></div><div class="st">${st}</div></a>`;
}

// ---------- 2. categories ----------
function categoriesScreen() {
  return shell(`<main><h1>Choose a book category</h1><p class="mut">Tap a category, or type any topic you like.</p>
    <div class="grid g3">${S.cfg.categories.map(catTile).join('')}</div>
    <form class="card tint-v row" data-form="topic"><label class="f grow">Or write your own topic<input type="text" name="topic" placeholder="e.g. unicorns, farm animals, the jungle" maxlength="80"></label><button class="btn p" type="submit">Next</button></form></main>`, 'create');
}

// ---------- 3. create / AI generation form ----------
function createScreen(params) {
  const maxPages = S.plan.maxPagesPerBook;
  return shell(`<main><h1>Build your colouring book</h1>${demoBanner()}
    <form class="card grid" data-form="create" style="gap:20px" novalidate>
      <label class="f">What is the book about?<input type="text" name="topic" value="${esc(params.topic || '')}" placeholder="dinosaurs, birds, flowers, cars, cartoon characters…" maxlength="80" required></label>
      <fieldset style="border:0;padding:0;margin:0"><legend class="b" style="margin-bottom:8px">How many pages?</legend><div class="opts">${S.cfg.pageOptions.map((n) => `<label class="opt"><input type="radio" name="pageCount" value="${n}" ${n === 10 ? 'checked' : ''}><span>${n}${n > maxPages ? ' · Premium' : ''}</span></label>`).join('')}</div></fieldset>
      <fieldset style="border:0;padding:0;margin:0"><legend class="b" style="margin-bottom:8px">Age group</legend><div class="opts">${S.cfg.ageGroups.map((a) => `<label class="opt"><input type="radio" name="ageGroup" value="${a.id}" ${a.id === '6-8' ? 'checked' : ''}><span>${esc(a.label)}</span></label>`).join('')}</div></fieldset>
      <div class="grid g2"><label class="f">Book title (optional)<input type="text" name="title" maxlength="80" placeholder="Auto-created from your topic"></label><label class="f">Author name (optional)<input type="text" name="author" maxlength="50" value="${esc(S.me.name)}"></label></div>
      <p class="err-msg" role="alert" style="color:var(--bad);font-weight:700"></p>
      <button class="btn p block" type="submit">Generate my book</button>
      <p class="mut sm-t">Uses one picture credit per page · ${S.usage.generationsLimit - S.usage.generationsToday} left today on the ${esc(S.plan.name)} plan.</p></form></main>`, 'create');
}

// ---------- book screens ----------
function steps(active) {
  const b = S.book, base = `#/book/${b.id}/`;
  const items = [['generate', 'Progress'], ['gallery', 'Gallery'], ['editor', 'Editor'], ['cover', 'Cover'], ['preview', 'Preview'], ['download', 'Download']];
  return `<div class="steps" role="navigation" aria-label="Book steps">${items.map(([k, l]) => `<a href="${base}${k}" class="${active === k ? 'on' : ''}">${l}</a>`).join('')}</div>`;
}
function bookScreen(sub) {
  const fn = { generate: generateView, gallery: galleryView, editor: editorView, cover: coverView, preview: previewView, download: downloadView }[sub] || galleryView;
  return shell(`<main><div class="row nw" style="justify-content:space-between"><div class="grow"><h1 style="font-size:26px">${esc(S.book.title)}</h1><p class="mut sm-t">${S.book.pages.length} pages · ${esc(AGE(S.book.ageGroup))}</p></div></div>${steps(sub)}${fn()}</main>${S.lb !== null && sub === 'gallery' ? lightbox() : ''}`, 'books');
}
const counts = (b) => ({ done: b.pages.filter((p) => p.status === 'done').length, err: b.pages.filter((p) => p.status === 'error').length, total: b.pages.length });

// 3b. generation progress
function generateView() {
  const b = S.book, c = counts(b), pct = Math.round((c.done / c.total) * 100);
  const running = b.status === 'generating';
  return `<div class="card grid"><div class="row">${running ? '<div class="spin"></div>' : ''}<h2>${running ? 'AI is drawing your pages…' : c.err ? 'Finished with a few problems' : 'Your book is ready!'}</h2></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
    <p class="mut">${c.done} of ${c.total} pages finished${c.err ? ` · <b style="color:var(--bad)">${c.err} failed</b>` : ''}</p>
    ${c.err ? `<div class="banner tint-c card">${esc(b.pages.find((p) => p.status === 'error').error)}</div><button class="btn p" data-act="retry-failed">Retry ${c.err} failed page${c.err > 1 ? 's' : ''}</button>` : ''}
    ${!running && c.done ? `<a class="btn p" href="#/book/${b.id}/gallery">Review illustrations</a>` : ''}</div>
    <div class="grid g3 g5">${b.pages.map((p, i) => `<div class="pg"><span class="no">${i + 1}</span><div class="st">${badge(p)}</div><div class="im">${p.status === 'done' ? `<img src="${thumb(b, p)}" alt="Page ${i + 1}: ${esc(p.idea)}" loading="lazy">` : p.status === 'error' ? '<span class="mut">!</span>' : '<div class="spin"></div>'}</div></div>`).join('')}</div>`;
}
// 4. gallery
function galleryView() {
  const b = S.book, c = counts(b);
  return `${demoBanner()}${c.err ? `<div class="banner tint-c card row"><span class="grow">${c.err} page${c.err > 1 ? 's' : ''} failed to draw.</span><button class="btn sm p" data-act="retry-failed">Retry</button></div>` : ''}
  <div class="grid g3 g5">${b.pages.map((p, i) => `<button class="pg" data-act="open-lb" data-i="${i}" aria-label="Open page ${i + 1}: ${esc(p.idea)}"><span class="no">${i + 1}</span><div class="st">${badge(p)}</div><div class="im">${p.status === 'done' ? `<img src="${thumb(b, p)}" alt="" loading="lazy">` : p.status === 'error' ? '<span class="mut">Tap to retry</span>' : '<div class="spin"></div>'}</div><div class="cap">${esc(p.idea)}</div></button>`).join('')}</div>
  <a class="btn p" href="#/book/${b.id}/editor">Edit &amp; reorder pages</a>`;
}
function lightbox() {
  const b = S.book, i = Math.min(S.lb, b.pages.length - 1), p = b.pages[i];
  if (!p) return '';
  return `<div class="overlay" role="dialog" aria-modal="true" aria-label="Page ${i + 1}"><div class="modal lb"><div class="row nw" style="justify-content:space-between"><h3>Page ${i + 1} of ${b.pages.length}</h3><button class="ibtn" data-act="close-lb" aria-label="Close">${icon('x')}</button></div>
  ${p.status === 'done' ? `<img src="/api/books/${b.id}/pages/${p.id}/image?size=preview&v=${p.version}" alt="${esc(p.idea)}">` : `<div class="empty">${p.status === 'error' ? `<p class="b" style="color:var(--bad)">${esc(p.error)}</p>` : '<div class="spin"></div><p>Still drawing…</p>'}</div>`}
  <p class="mut">${esc(p.idea)}</p>
  <div class="row"><button class="ibtn" data-act="lb-prev" aria-label="Previous page" ${i === 0 ? 'disabled' : ''}>${icon('prev')}</button><button class="ibtn" data-act="lb-next" aria-label="Next page" ${i === b.pages.length - 1 ? 'disabled' : ''}>${icon('next')}</button><span class="grow"></span>
  ${p.status !== 'generating' && p.status !== 'pending' ? `<button class="btn sm" data-act="regen" data-id="${p.id}">${icon('redo')} ${p.status === 'error' ? 'Retry' : 'Redraw'}</button>` : ''}
  ${p.status === 'done' ? `<button class="btn sm" data-act="set-cover" data-id="${p.id}">Use on cover</button><a class="btn sm p" href="/api/books/${b.id}/pages/${p.id}/image?download=1" download>${icon('dl')} PNG</a>` : ''}</div></div></div>`;
}
// 5. editor
function editorView() {
  const b = S.book, plan = S.plan;
  const uploads = b.pages.filter((p) => p.source === 'upload').length;
  return `<div class="card grid"><h3>Pages</h3><p class="mut sm-t">Drag rows (desktop) or use the arrows to reorder. Edit the description and tap redraw to replace a picture.</p>
  ${b.pages.map((p, i) => `<div class="erow" draggable="true" data-id="${p.id}" data-row>
    <div class="th">${p.status === 'done' ? `<img src="${thumb(b, p)}" alt="" loading="lazy">` : p.status === 'error' ? '<span>!</span>' : '<div class="spin"></div>'}</div>
    <div class="grow"><div class="row nw"><span class="chip">#${i + 1}</span>${badge(p)}${p.source === 'upload' ? '<span class="chip">Your photo</span>' : ''}</div>
    <label class="f" style="margin-top:6px"><span class="sm-t mut">Picture idea</span><input type="text" value="${esc(p.idea)}" maxlength="200" data-idea="${p.id}"></label>
    <div class="acts"><button class="ibtn" data-act="move" data-id="${p.id}" data-d="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="ibtn" data-act="move" data-id="${p.id}" data-d="1" aria-label="Move down" ${i === b.pages.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
    <button class="btn sm" data-act="regen" data-id="${p.id}" ${p.status === 'generating' || p.status === 'pending' ? 'disabled' : ''}>${icon('redo')} Redraw</button>
    <button class="btn sm" data-act="replace-up" data-id="${p.id}">${icon('img')} Replace</button>
    <button class="ibtn" style="background:var(--coral-t);color:#8A1C12" data-act="del-page" data-id="${p.id}" aria-label="Delete page ${i + 1}" ${b.pages.length <= 1 ? 'disabled' : ''}>${icon('trash')}</button></div></div></div>`).join('')}</div>
  <div class="card grid tint-v"><h3>Add a picture</h3>
    <form class="row nw" data-form="add-page"><label class="f grow"><span class="sm-t mut">Describe it</span><input type="text" name="idea" placeholder="a smiling sun with sunglasses" maxlength="200"></label><button class="btn p" type="submit" style="align-self:flex-end">Add</button></form>
    <hr style="border:0;border-top:2px solid var(--line);width:100%"><h3>Use your own picture</h3><p class="mut sm-t">Upload a photo or drawing (JPG, PNG, WebP, up to 10 MB). Photos are converted into colouring outlines. ${uploads}/${plan.maxUploadsPerBook} uploads used.</p>
    <div class="row"><label class="f"><span class="sm-t mut">Conversion</span><select id="upmode"><option value="outline">Turn photo into outline</option><option value="asis">Already line art - just clean up</option></select></label><button class="btn" data-act="add-up">${icon('img')} Upload picture</button></div></div>
  <input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
  <div class="card grid"><h3>Print options</h3>
    <label class="row nw"><input type="checkbox" data-setting="includeTitlePage" ${b.settings.includeTitlePage ? 'checked' : ''} style="width:24px;height:24px"> Include a title page</label>
    <label class="row nw"><input type="checkbox" data-setting="showPageNumbers" ${b.settings.showPageNumbers ? 'checked' : ''} style="width:24px;height:24px"> Show page numbers</label></div>
  <div class="row"><a class="btn p grow" href="#/book/${b.id}/cover">Next: design the cover</a></div>`;
}
// 6. cover
function coverView() {
  const b = S.book, done = b.pages.filter((p) => p.status === 'done');
  return `<div class="grid" style="gap:20px"><img id="coverImg" class="cover-img" src="/api/books/${b.id}/cover?size=preview&t=${S.ts}" alt="Cover preview">
  <div class="card grid"><label class="f">Book title<input type="text" data-cover="title" value="${esc(b.title)}" maxlength="80"></label>
  <label class="f">Subtitle (optional)<input type="text" data-cover="subtitle" value="${esc(b.subtitle)}" maxlength="48"></label>
  <label class="f">Author<input type="text" data-cover="author" value="${esc(b.author)}" maxlength="50"></label>
  <div><p class="b" style="margin-bottom:8px">Cover colour</p><div class="row">${S.cfg.themes.map((t) => `<button class="sw" style="background:${t.bg}" data-act="theme" data-c="${t.id}" aria-label="${t.id}" aria-pressed="${b.theme.color === t.id}"></button>`).join('')}</div></div>
  <div><p class="b" style="margin-bottom:8px">Cover picture</p><div class="row nw" style="overflow-x:auto;padding-bottom:6px">${done.map((p) => `<button class="pg" style="width:84px;flex:none;${b.theme.coverPageId === p.id ? 'border-color:var(--violet);border-width:4px' : ''}" data-act="set-cover" data-id="${p.id}" aria-label="Use this picture on the cover" aria-pressed="${b.theme.coverPageId === p.id}"><div class="im"><img src="${thumb(b, p)}" alt=""></div></button>`).join('') || '<span class="mut">Pictures appear here when ready.</span>'}</div></div></div>
  <a class="btn p" href="#/book/${b.id}/preview">Next: preview PDF</a></div>`;
}
// 7. preview
function previewView() {
  const b = S.book, done = b.pages.filter((p) => p.status === 'done');
  if (!done.length) return '<div class="card empty"><p>No pages are finished yet.</p></div>';
  let n = 0;
  return `<div class="card row tint-v"><p class="grow"><b>Print preview</b> · A4 portrait · dashed line = 15&nbsp;mm safe margin</p><button class="btn p sm" data-act="print">Print</button><a class="btn sm" href="/api/books/${b.id}/pdf?inline=1" target="_blank" rel="noopener">Open PDF</a></div>
  <p class="mut sm-t" style="text-align:center">Cover</p><div class="sheet"><img src="/api/books/${b.id}/cover?size=preview&t=${S.ts}" alt="Cover"></div>
  ${b.settings.includeTitlePage ? `<p class="mut sm-t" style="text-align:center">Title page</p><div class="sheet"><img src="/api/books/${b.id}/title-page?t=${S.ts}" alt="Title page"></div>` : ''}
  ${done.map((p) => { n += 1; return `<p class="mut sm-t" style="text-align:center">Page ${n}</p><div class="sheet pgimg"><div class="safe"></div><img src="/api/books/${b.id}/pages/${p.id}/image?size=preview&v=${p.version}" alt="Page ${n}: ${esc(p.idea)}" loading="lazy">${b.settings.showPageNumbers ? `<div class="num">${n}</div>` : ''}</div>`; }).join('')}
  <a class="btn p" href="#/book/${b.id}/download">Next: download</a>`;
}
// 8. download
function downloadView() {
  const b = S.book, c = counts(b);
  return `<div class="card grid"><h2>Your colouring book is ${c.done === c.total ? 'ready' : 'almost ready'}</h2>
  <p class="mut">A4 portrait · 15&nbsp;mm margins · ${c.done} colouring pages + cover${b.settings.includeTitlePage ? ' + title page' : ''} · 300&nbsp;DPI black-and-white line art</p>
  ${c.done < c.total ? `<div class="banner tint-s card">${c.total - c.done} page${c.total - c.done > 1 ? 's are' : ' is'} not finished and will be skipped. <a href="#/book/${b.id}/gallery">Fix pages</a></div>` : ''}
  ${S.plan.footer ? `<div class="banner tint-v card">Free plan PDFs include a small "Made with ColourBook Studio AI" footer. <a href="#/settings">Upgrade to remove it</a>.</div>` : ''}
  <button class="btn p block" data-act="dl-pdf" ${c.done ? '' : 'disabled'}>${icon('dl')} Download PDF</button>
  <div class="row"><button class="btn grow" data-act="dl-zip" ${c.done ? '' : 'disabled'}>${icon('img')} Download all images (ZIP)</button><button class="btn grow" data-act="print" ${c.done ? '' : 'disabled'}>Print</button></div>
  <p class="mut sm-t" id="dlstatus" role="status"></p></div>
  <div class="card grid"><h3>Download single pages</h3><div class="grid g3 g5"><a class="pg" href="/api/books/${b.id}/cover?size=full&download=1" download style="text-decoration:none;color:inherit"><div class="im"><img src="/api/books/${b.id}/cover?size=preview&t=${S.ts}" alt=""></div><div class="cap">Cover</div></a>
  ${b.pages.map((p, i) => p.status === 'done' ? `<a class="pg" href="/api/books/${b.id}/pages/${p.id}/image?download=1" download style="text-decoration:none;color:inherit"><span class="no">${i + 1}</span><div class="im"><img src="${thumb(b, p)}" alt="" loading="lazy"></div><div class="cap">${icon('dl').replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px"')} PNG</div></a>` : '').join('')}</div></div>`;
}

// ---------- 9. library ----------
function libraryScreen() {
  return shell(`<main><div class="row" style="justify-content:space-between"><h1>My Books</h1><a class="btn p sm" href="#/categories">${icon('plus').replace('<svg', '<svg width="20" height="20"')} New book</a></div>
  ${S.books.length ? `<div class="grid">${S.books.map((b) => {
    const img = b.thumbPageId ? `<img src="/api/books/${b.id}/pages/${b.thumbPageId}/image?size=thumb&v=${b.thumbVersion}" alt="">` : '<div class="spin"></div>';
    return `<div class="card row nw"><a class="th" href="#/book/${b.id}/${b.status === 'generating' ? 'generate' : 'editor'}" style="width:70px;aspect-ratio:2/3;border:2px solid var(--line);border-radius:12px;display:flex;align-items:center;justify-content:center;flex:none">${img}</a>
    <div class="grow"><a href="#/book/${b.id}/${b.status === 'generating' ? 'generate' : 'editor'}" class="b" style="text-decoration:none;color:inherit;font-size:19px">${esc(b.title)}</a><p class="mut sm-t">${b.donePages}/${b.pageCount} pages · ${esc(AGE(b.ageGroup))} · ${new Date(b.updatedAt).toLocaleDateString()}</p>
    <div class="acts"><a class="btn sm p" href="#/book/${b.id}/download">Download</a><button class="btn sm" data-act="rename" data-id="${b.id}">Rename</button><button class="btn sm" data-act="dup" data-id="${b.id}">Duplicate</button><button class="btn sm d" data-act="del-book" data-id="${b.id}">Delete</button></div></div></div>`;
  }).join('')}</div>` : '<div class="card empty"><h2>Your library is empty</h2><p class="mut">Books you create are saved here so you can keep editing later.</p><a class="btn p" href="#/categories">Create a book</a></div>'}</main>`, 'books');
}

// ---------- 10. settings ----------
function settingsScreen() {
  const u = S.me, p = S.plan, premium = u.plan === 'premium';
  const pct = Math.min(100, Math.round((S.usage.generationsToday / S.usage.generationsLimit) * 100));
  return shell(`<main><h1>Settings &amp; account</h1>
  <div class="card grid"><h3>Your plan: ${esc(p.name)}</h3>
    <ul class="mut" style="margin:0;padding-left:20px"><li>Up to ${p.maxPagesPerBook} pages per book</li><li>${p.maxBooks} saved books</li><li>${p.dailyGenerations} pictures per day</li><li>${p.footer ? 'Small footer on PDFs' : 'No footer on PDFs'}</li></ul>
    <div class="bar"><div style="width:${pct}%"></div></div><p class="mut sm-t">${S.usage.generationsToday} of ${S.usage.generationsLimit} pictures used today</p>
    ${premium ? (u.hasBilling ? '<button class="btn" data-act="portal">Manage subscription</button>' : '') : '<div class="banner tint-s card"><b>Premium</b> unlocks books up to 50 pages, 200 saved books, 300 pictures a day and PDFs without the footer.</div><button class="btn p" data-act="upgrade">Upgrade to Premium</button>'}
    ${S.cfg.devPlanSwitch ? `<button class="btn sm" data-act="dev-plan" data-plan="${premium ? 'free' : 'premium'}">Dev only: switch to ${premium ? 'Free' : 'Premium'}</button>` : ''}</div>
  <div class="card grid"><h3>Account</h3><p class="mut">${esc(u.email)}</p><form class="row nw" data-form="name"><label class="f grow">Display name<input type="text" name="name" value="${esc(u.name)}" maxlength="60"></label><button class="btn p" type="submit" style="align-self:flex-end">Save</button></form>
    <div class="row"><button class="btn" data-act="password">Change password</button><button class="btn" data-act="logout">Sign out</button></div></div>
  <div class="card grid tint-c"><h3>Delete account</h3><p>Permanently deletes your account and all your books.</p><button class="btn d" data-act="delete-account">Delete my account</button></div>
  </main>`, 'settings');
}

// ---------- actions ----------
const bookId = () => S.book?.id;
const setBook = (b) => { S.book = b; S.ts = Date.now(); };
const act = {
  reload: () => route(),
  async logout() { await api('POST', '/api/auth/logout'); S.me = null; S.book = null; go('#/login'); },
  'open-lb': (el) => { S.lb = Number(el.dataset.i); render(bookScreen('gallery')); },
  'close-lb': () => { S.lb = null; render(bookScreen('gallery')); },
  'lb-prev': () => { S.lb = Math.max(0, S.lb - 1); render(bookScreen('gallery')); },
  'lb-next': () => { S.lb = Math.min(S.book.pages.length - 1, S.lb + 1); render(bookScreen('gallery')); },
  async regen(el) {
    const input = $(`[data-idea="${el.dataset.id}"]`);
    const body = input ? { idea: input.value } : {};
    try { setBook((await api('POST', `/api/books/${bookId()}/pages/${el.dataset.id}/regenerate`, body)).book); toast('Redrawing this page…'); await refreshMe(); render(bookScreen(S.r.seg[2] || 'gallery')); startPoll(); }
    catch (e) { fail(e, () => act.regen(el)); }
  },
  async 'retry-failed'() {
    try { setBook((await api('POST', `/api/books/${bookId()}/retry-failed`)).book); render(bookScreen(S.r.seg[2] || 'gallery')); startPoll(); }
    catch (e) { fail(e, act['retry-failed']); }
  },
  async 'set-cover'(el) {
    try { setBook((await api('PATCH', `/api/books/${bookId()}`, { theme: { coverPageId: el.dataset.id } })).book); S.lb = null; render(bookScreen(S.r.seg[2] || 'gallery')); toast('Cover picture updated'); }
    catch (e) { fail(e); }
  },
  async theme(el) { try { setBook((await api('PATCH', `/api/books/${bookId()}`, { theme: { color: el.dataset.c } })).book); render(bookScreen('cover')); } catch (e) { fail(e); } },
  async move(el) {
    const ids = S.book.pages.map((p) => p.id), i = ids.indexOf(el.dataset.id), j = i + Number(el.dataset.d);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { setBook((await api('PATCH', `/api/books/${bookId()}`, { order: ids })).book); render(bookScreen('editor')); } catch (e) { fail(e); }
  },
  async 'del-page'(el) {
    if (!(await confirmBox('Delete this page?', 'The picture will be removed from your book.', 'Delete', true))) return;
    try { setBook((await api('DELETE', `/api/books/${bookId()}/pages/${el.dataset.id}`)).book); render(bookScreen('editor')); } catch (e) { fail(e); }
  },
  'replace-up': (el) => { S.uploadTarget = el.dataset.id; $('#file').click(); },
  'add-up': () => { S.uploadTarget = null; $('#file').click(); },
  async print() { await printBook(); },
  async 'dl-pdf'(el) { await doDownload(el, `/api/books/${bookId()}/pdf`, 'colouring-book-A4.pdf'); },
  async 'dl-zip'(el) { await doDownload(el, `/api/books/${bookId()}/images.zip`, 'colouring-book-images.zip'); },
  async rename(el) {
    const b = S.books.find((x) => x.id === el.dataset.id);
    const t = await promptBox('Rename book', b.title, 'text', 'Book title');
    if (!t || !t.trim()) return;
    try { await api('PATCH', `/api/books/${b.id}`, { title: t }); route(); } catch (e) { fail(e); }
  },
  async dup(el) { try { await api('POST', `/api/books/${el.dataset.id}/duplicate`); toast('Book duplicated'); route(); } catch (e) { fail(e); } },
  async 'del-book'(el) {
    const b = S.books.find((x) => x.id === el.dataset.id);
    if (!(await confirmBox(`Delete "${b.title}"?`, 'This permanently removes the book and all its pictures.', 'Delete book', true))) return;
    try { await api('DELETE', `/api/books/${b.id}`); toast('Book deleted'); route(); } catch (e) { fail(e); }
  },
  async upgrade() {
    try { location.href = (await api('POST', '/api/billing/checkout')).url; }
    catch (e) { if (e.data?.code === 'payments_disabled') modal(`<h2>Payments are not set up yet</h2><p class="mut">The site owner has not configured secure payments. Premium will be available once Stripe is connected on the server.</p><button class="btn p" data-m="no">OK</button>`); else fail(e); }
  },
  async portal() { try { location.href = (await api('POST', '/api/billing/portal')).url; } catch (e) { fail(e); } },
  async 'dev-plan'(el) { try { await api('POST', '/api/me/plan', { plan: el.dataset.plan }); await refreshMe(); route(); } catch (e) { fail(e); } },
  async password() {
    const r = await modal(`<h2>Change password</h2><label class="f">Current password<input type="password" id="pw1" autocomplete="current-password"></label><label class="f">New password (8+ characters)<input type="password" id="pw2" autocomplete="new-password"></label><div class="row"><button class="btn p grow" data-m="ok">Change</button><button class="btn grow" data-m="no">Cancel</button></div>`);
    if (!r) return;
    try { await api('POST', '/api/me/password', { current: r.pw1, next: r.pw2 }); toast('Password changed'); } catch (e) { fail(e); }
  },
  async 'delete-account'() {
    const pw = await promptBox('Delete account', '', 'password', 'Enter your password to confirm');
    if (!pw) return;
    try { await api('DELETE', '/api/me', { password: pw }); S.me = null; toast('Account deleted'); go('#/login'); } catch (e) { fail(e); }
  },
};
async function doDownload(el, url, fallback) {
  const label = el.innerHTML, st = $('#dlstatus');
  el.disabled = true; el.innerHTML = '<span class="spin" style="width:22px;height:22px;border-width:4px"></span> Preparing…';
  try {
    const r = await downloadFile(url, fallback);
    if (st) st.textContent = `Saved ${r.name} (${sizeMB(r.size)}). Check your Downloads folder.`;
    toast('Download started');
  } catch (e) { fail(e, () => doDownload(el, url, fallback)); }
  finally { el.disabled = false; el.innerHTML = label; }
}
async function printBook() {
  const b = S.book, done = b.pages.filter((p) => p.status === 'done');
  if (!done.length) return toast('No finished pages to print yet.', 'err');
  let n = 0;
  const root = $('#print-root');
  root.innerHTML = `<div class="ps full"><img src="/api/books/${b.id}/cover?size=full&t=${Date.now()}" alt=""></div>${b.settings.includeTitlePage ? `<div class="ps full"><img src="/api/books/${b.id}/title-page?size=full&t=${Date.now()}" alt=""></div>` : ''}` +
    done.map((p) => { n += 1; return `<div class="ps pgimg"><img src="/api/books/${b.id}/pages/${p.id}/image?v=${p.version}" alt="">${b.settings.showPageNumbers ? `<div class="num">${n}</div>` : ''}</div>`; }).join('');
  toast('Preparing print preview…');
  await Promise.all($$('img', root).map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));
  document.body.classList.add('printing');
  const clear = () => { document.body.classList.remove('printing'); root.innerHTML = ''; window.removeEventListener('afterprint', clear); };
  window.addEventListener('afterprint', clear);
  window.print();
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !act[el.dataset.act]) return;
  e.preventDefault();
  Promise.resolve(act[el.dataset.act](el)).catch((err) => fail(err));
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form, d = Object.fromEntries(new FormData(f));
  const errEl = $('.err-msg', f), setErr = (m) => { if (errEl) errEl.textContent = m; else toast(m, 'err'); };
  const btn = $('button[type=submit]', f);
  try {
    if (kind === 'login' || kind === 'signup') {
      btn.disabled = true;
      await api('POST', `/api/auth/${kind}`, d);
      S.me = null; location.hash = '#/home'; await route();
    } else if (kind === 'topic') {
      if (!d.topic.trim()) return;
      go(`#/create?topic=${encodeURIComponent(d.topic.trim())}`);
    } else if (kind === 'create') {
      if (d.topic.trim().length < 2) return setErr('Please enter a topic for your book.');
      btn.disabled = true; btn.textContent = 'Starting…';
      const { book } = await api('POST', '/api/books', { ...d, pageCount: Number(d.pageCount) });
      S.book = book; S.lb = null; await refreshMe();
      go(`#/book/${book.id}/generate`);
    } else if (kind === 'add-page') {
      if (!d.idea.trim()) return;
      setBook((await api('POST', `/api/books/${bookId()}/pages`, { idea: d.idea })).book); await refreshMe(); render(bookScreen('editor')); startPoll();
    } else if (kind === 'name') {
      S.me = (await api('PATCH', '/api/me', { name: d.name })).user; toast('Name saved'); route();
    }
  } catch (err) {
    if (err.status === 402 || err.data?.code === 'upgrade') { setErr(err.message); toast(err.message, 'err', { label: 'Upgrade', fn: () => go('#/settings') }); }
    else setErr(err.message);
    if (btn) { btn.disabled = false; if (kind === 'create') btn.textContent = 'Generate my book'; }
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.id === 'file' && t.files[0]) {
      const fd = new FormData();
      fd.set('image', t.files[0]); fd.set('mode', $('#upmode')?.value || 'outline');
      if (S.uploadTarget) fd.set('pageId', S.uploadTarget);
      t.value = '';
      toast('Converting your picture…');
      setBook((await api('POST', `/api/books/${bookId()}/pages/upload`, fd)).book); render(bookScreen('editor')); startPoll();
    } else if (t.dataset.idea) {
      await api('PATCH', `/api/books/${bookId()}/pages/${t.dataset.idea}`, { idea: t.value });
      S.book.pages.find((p) => p.id === t.dataset.idea).idea = t.value.trim();
      toast('Description saved. Tap Redraw to replace the picture.');
    } else if (t.dataset.setting) {
      setBook((await api('PATCH', `/api/books/${bookId()}`, { settings: { [t.dataset.setting]: t.checked } })).book);
    }
  } catch (err) { fail(err); }
});
let coverTimer;
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.cover;
  if (!k) return;
  clearTimeout(coverTimer);
  coverTimer = setTimeout(async () => {
    try {
      setBook((await api('PATCH', `/api/books/${bookId()}`, { [k]: e.target.value })).book);
      const img = $('#coverImg'); if (img) img.src = `/api/books/${bookId()}/cover?size=preview&t=${S.ts}`;
    } catch (err) { fail(err); }
  }, 600);
});
// drag & drop reorder (desktop); touch users use the arrow buttons
let dragId = null;
document.addEventListener('dragstart', (e) => { const r = e.target.closest?.('[data-row]'); if (r) { dragId = r.dataset.id; r.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch { /* */ } } });
document.addEventListener('dragend', () => { dragId = null; $$('.erow').forEach((r) => r.classList.remove('drag', 'over')); });
document.addEventListener('dragover', (e) => { const r = e.target.closest?.('[data-row]'); if (r && dragId) { e.preventDefault(); $$('.erow').forEach((x) => x.classList.toggle('over', x === r && x.dataset.id !== dragId)); } });
document.addEventListener('drop', async (e) => {
  const r = e.target.closest?.('[data-row]');
  if (!r || !dragId || r.dataset.id === dragId) return;
  e.preventDefault();
  const ids = S.book.pages.map((p) => p.id), from = ids.indexOf(dragId), to = ids.indexOf(r.dataset.id);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  try { setBook((await api('PATCH', `/api/books/${bookId()}`, { order: ids })).book); render(bookScreen('editor')); } catch (err) { fail(err); }
});
document.addEventListener('keydown', (e) => {
  if (S.lb === null || !S.book || $('.overlay input')) return;
  if (e.key === 'Escape') act['close-lb'](); else if (e.key === 'ArrowLeft') act['lb-prev'](); else if (e.key === 'ArrowRight') act['lb-next']();
});
window.addEventListener('hashchange', () => { S.lb = null; route(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
