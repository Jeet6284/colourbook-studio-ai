'use strict';
// UI smoke test: runs the real frontend (public/app.js) in jsdom against a real server instance
// and walks through every screen. It cannot judge visual layout (use a real browser for that),
// but it catches script errors, broken routes and broken API wiring.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-ui-'));
process.env.IMAGE_PROVIDER = 'demo';
process.env.ALLOW_DEV_PLAN_SWITCH = 'true';
process.env.NODE_ENV = 'test';
const { JSDOM } = require('jsdom');
const { createApp } = require('../server/index');

let server, base, dom, win, doc, cookie = '';
const errors = [];
before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').replace(/<link[^>]*googleapis[^>]*>/g, ''), { url: `${base}/`, runScripts: 'outside-only', pretendToBeVisual: true });
  win = dom.window; doc = win.document;
  win.fetch = async (url, opt = {}) => {
    const headers = { ...(opt.headers || {}), ...(cookie ? { cookie } : {}) };
    const res = await fetch(new URL(url, base), { ...opt, headers });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return res;
  };
  win.print = () => { win.__printed = true; };
  win.URL.createObjectURL = () => 'blob:x'; win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { win.__downloaded = this.download; };
  win.addEventListener('error', (e) => errors.push(e.message));
  win.eval(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'));
});
after(() => { win.close(); server.close(); });

const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn.toString() + '\n' + doc.body.textContent.slice(0, 300)); await new Promise((r) => setTimeout(r, 50)); } };
const $ = (s) => doc.querySelector(s);
const text = () => doc.getElementById('app').textContent;
const nav = async (h) => { win.location.hash = h; await new Promise((r) => setTimeout(r, 100)); };
const submit = (form) => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

test('sign-up screen, then home dashboard', async () => {
  await until(() => $('form[data-form=login]'));
  await nav('#/login?mode=signup');
  const f = await until(() => $('form[data-form=signup]'));
  f.querySelector('[name=name]').value = 'Maya Rao'; f.querySelector('[name=email]').value = 'maya@example.com'; f.querySelector('[name=password]').value = 'a good password';
  submit(f);
  await until(() => /Hi Maya/.test(text()));
  assert.match(text(), /Demo mode/);
});

test('categories -> create form -> generation progress -> gallery', async () => {
  await nav('#/categories');
  await until(() => /Choose a book category/.test(text()));
  assert.ok($$('.tile').length >= 9);
  await nav('#/create?topic=dinosaurs');
  const f = await until(() => $('form[data-form=create]'));
  assert.equal(f.querySelector('[name=topic]').value, 'dinosaurs');
  f.querySelector('[name=ageGroup][value="3-5"]').checked = true;
  submit(f);
  await until(() => /#\/book\/[a-f0-9]+\/generate/.test(win.location.hash));
  await until(() => /Your book is ready/.test(text()), 40000);
  assert.equal($$('.pg img').length, 10);
  await nav(win.location.hash.replace('generate', 'gallery'));
  await until(() => $$('button.pg').length === 10);
  click($$('button.pg')[0]);
  await until(() => $('.lb'));
  assert.match($('.lb').textContent, /Page 1 of 10/);
  click($('[data-act=lb-next]'));
  await until(() => /Page 2 of 10/.test($('.lb').textContent));
  click($('[data-act=close-lb]'));
  await until(() => !$('.lb'));
});
function $$(s) { return [...doc.querySelectorAll(s)]; }

test('editor: reorder, edit idea, delete; cover designer; preview; download; print', async () => {
  const id = win.location.hash.split('/')[2];
  await nav(`#/book/${id}/editor`);
  await until(() => $$('[data-row]').length === 10);
  const first = $$('[data-row]')[0].dataset.id;
  click($('[data-act=move][data-d="1"]'));
  await until(() => $$('[data-row]')[1].dataset.id === first);
  await nav(`#/book/${id}/cover`);
  await until(() => $('#coverImg'));
  click($$('[data-act=theme]')[4]);
  await until(() => $$('[data-act=theme]')[4].getAttribute('aria-pressed') === 'true');
  await nav(`#/book/${id}/preview`);
  await until(() => $$('.sheet').length === 12);
  click($('[data-act=print]'));
  await until(() => win.__printed);
  await nav(`#/book/${id}/download`);
  await until(() => $('[data-act=dl-pdf]'));
  click($('[data-act=dl-pdf]'));
  await until(() => win.__downloaded === 'dinosaurs-colouring-book-A4.pdf', 15000);
  click($('[data-act=dl-zip]'));
  await until(() => win.__downloaded === 'dinosaurs-colouring-book-images.zip', 15000);
});

test('library, settings, premium upgrade path, sign out', async () => {
  await nav('#/books');
  await until(() => /My Books/.test(text()) && /Dinosaurs Colouring Book/.test(text()));
  click($('[data-act=dup]'));
  await until(() => $$('.card.row').length === 2);
  await nav('#/settings');
  await until(() => /Your plan: Free/.test(text()));
  click($('[data-act=upgrade]'));
  await until(() => $('.overlay') && /not set up yet/.test($('.overlay').textContent));
  click($('[data-m=no]'));
  click($('[data-act=dev-plan]'));
  await until(() => /Your plan: Premium/.test(text()));
  click($('[data-act=logout]'));
  await until(() => $('form[data-form=login]'));
  assert.deepEqual(errors, []);
});
