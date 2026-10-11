'use strict';
// In-process generation queue. Pages are generated with limited concurrency; clients poll the book.
// For horizontal scaling move this to a real queue (BullMQ/SQS) - the interface stays the same.
const cfg = require('./config');
const store = require('./store');
const providers = require('./providers');
const imaging = require('./imaging');

const queue = [];
let running = 0;

function enqueue(bookId, pageId, { uploadBuffer, mode } = {}) {
  const book = store.getBook(bookId);
  const page = book?.pages.find((p) => p.id === pageId);
  if (!page) return;
  page.status = 'pending'; page.error = ''; book.status = 'generating';
  queue.push({ bookId, pageId, uploadBuffer, mode, attempt: 0 });
  store.saveBook(book);
  pump();
}
function pump() {
  while (running < cfg.genConcurrency && queue.length) {
    const job = queue.shift();
    running += 1;
    run(job).catch((e) => console.error('job crashed', e)).finally(() => { running -= 1; pump(); });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(job) {
  const book = store.getBook(job.bookId);
  const page = book?.pages.find((p) => p.id === job.pageId);
  if (!page) return; // deleted meanwhile
  page.status = 'generating';
  try {
    let raw;
    if (job.uploadBuffer) {
      raw = job.mode === 'asis' ? await imaging.toPrintLineArt(job.uploadBuffer) : await imaging.photoToOutline(job.uploadBuffer);
    } else {
      for (;;) {
        try { raw = await imaging.toPrintLineArt(await providers.generate({ idea: page.idea, age: book.ageGroup, seed: `${page.id}${page.version}` })); break; }
        catch (e) {
          if (e.retryable && job.attempt < 2) { job.attempt += 1; await sleep(1500 * job.attempt); continue; }
          throw e;
        }
      }
    }
    if (!store.getBook(job.bookId) || !book.pages.includes(page)) return; // removed while generating
    await store.writePageImage(book.id, page.id, raw);
    page.version += 1; page.status = 'done'; page.error = '';
  } catch (e) {
    page.status = 'error';
    page.error = e.code ? e.message : (job.uploadBuffer ? 'That image could not be converted. Try another file.' : 'Generation failed. Please retry.');
    if (!e.code) console.error('generation error:', e);
  }
  settle(book);
  await store.saveBook(book);
}
function settle(book) {
  const open = book.pages.some((p) => p.status === 'pending' || p.status === 'generating');
  const failed = book.pages.some((p) => p.status === 'error');
  book.status = open ? 'generating' : failed ? 'partial' : 'ready';
}
module.exports = { enqueue, settle };
