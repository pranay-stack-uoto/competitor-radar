// Aggregate download budget: counts real bytes, stops the crawl, and keeps memory bounded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import guardModule from '../../lib/security/netguard.js';
import crawler from '../../lib/crawl.js';
import audit from '../../lib/audit.js';
import queue from '../../lib/queue.js';
import { web, html, page, cfgOf } from '../helpers/fakeweb.mjs';

const { createGuard, createByteBudget, GuardError, isBlockedAddress } = guardModule;
const A = (address) => ({ address, family: 4 });
const dns = (host, o, cb) => setImmediate(() => (host === 'allowed.example' ? cb(null, [A('127.0.0.1')]) : cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }))));
const guard = () => createGuard({ lookup: dns, isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip), anyPort: true });

let server, port, hits, endlessClosed;
const at = (p) => `http://allowed.example:${port}${p}`;
const KB = 1024, MB = 1024 * 1024;

before(async () => {
  hits = 0; endlessClosed = 0;
  server = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    let m;
    if ((m = /^\/chunked\/(\d+)$/.exec(p))) { // no Content-Length: only the bytes that actually arrive count
      res.writeHead(200, { 'content-type': 'text/html' });
      let left = Number(m[1]); const chunk = Buffer.alloc(16 * KB, 97);
      (function pump() { while (left > 0) { const n = Math.min(left, chunk.length); left -= n; if (!res.write(chunk.subarray(0, n))) return res.once('drain', pump); } res.end(); })();
      return;
    }
    if (p === '/gzip-bomb') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(30 * MB, 97))); }
    if (p === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(Buffer.alloc(1 * MB, 97)); }
    if (p === '/endless') {
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = Buffer.alloc(64 * KB, 97); let stop = false;
      res.on('close', () => { stop = true; endlessClosed++; });
      (function pump() { while (!stop) { if (!res.write(chunk)) return res.once('drain', pump); } })();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

// ---------- the budget object ----------
test('a budget needs a positive size, counts what is added, and stays exhausted once spent', () => {
  for (const bad of [0, -1, NaN, Infinity, undefined, null, '5']) assert.throws(() => createByteBudget(bad), /positive number/, String(bad));
  const b = createByteBudget(100);
  b.add(60); assert.equal(b.used, 60); assert.equal(b.remaining(), 40); b.assertOpen();
  assert.throws(() => b.add(50), (e) => e instanceof GuardError && e.code === 'budget-exhausted');
  assert.equal(b.exhausted, true);
  assert.throws(() => b.assertOpen(), (e) => e.code === 'budget-exhausted');
  assert.equal(b.remaining(), 0);
});

// ---------- counting real bytes ----------
test('counts the bytes that actually arrive, with no Content-Length to rely on', async () => {
  const b = createByteBudget(10 * MB);
  const r = await guard().request(at('/chunked/300000'), { budget: b });
  assert.equal(r.body.length, 300000);
  assert.equal(b.used, 300000 + b.requestOverhead);
});

test('the budget is shared across requests; when it runs out the crawl cannot continue and no further request reaches the server', async () => {
  const g = guard(), b = createByteBudget(1 * MB); hits = 0;
  for (let i = 0; i < 3; i++) await g.request(at('/chunked/300000'), { budget: b });
  assert.ok(b.used < 1 * MB);
  await assert.rejects(g.request(at('/chunked/300000'), { budget: b }), (e) => e instanceof GuardError && e.code === 'budget-exhausted');
  const before = hits;
  await assert.rejects(g.request(at('/ok'), { budget: b }), (e) => e.code === 'budget-exhausted');
  await assert.rejects(g.safeFetch(at('/ok'), { budget: b }), (e) => e.code === 'budget-exhausted');
  assert.equal(hits, before, 'an exhausted budget sends nothing');
});

test('a compression bomb is counted after decompression, so a tiny download cannot hide a huge payload', async () => {
  const compressed = zlib.gzipSync(Buffer.alloc(30 * MB, 97)).length;
  assert.ok(compressed < 100 * KB, `the bomb is ${compressed} bytes on the wire`);
  const b = createByteBudget(1 * MB);
  await assert.rejects(guard().request(at('/gzip-bomb'), { budget: b, maxBytes: 100 * MB }), (e) => e.code === 'budget-exhausted');
  assert.ok(b.used < 1 * MB + 512 * KB, `stopped near the budget, used ${b.used}`);
});

test('the per-response limit still applies on its own, whatever the budget', async () => {
  const b = createByteBudget(500 * MB);
  await assert.rejects(guard().request(at('/chunked/2000000'), { budget: b, maxBytes: 500 * KB }), (e) => e.code === 'too-large');
  const plain = await guard().request(at('/chunked/2000000'), { maxBytes: 5 * MB }); // no budget at all: unchanged behaviour
  assert.equal(plain.body.length, 2000000);
});

test('requests without a body still cost something, so endless HEADs cannot run forever', async () => {
  const b = createByteBudget(5000, { requestOverhead: 1024 }); hits = 0;
  for (let i = 0; i < 4; i++) await guard().request(at('/ok'), { method: 'HEAD', budget: b });
  await assert.rejects(guard().request(at('/ok'), { method: 'HEAD', budget: b }), (e) => e.code === 'budget-exhausted');
  assert.equal(hits, 4);
});

test('a response of a type we did not ask for is not downloaded, and is not charged beyond the request cost', async () => {
  const b = createByteBudget(10 * MB);
  const r = await guard().request(at('/json'), { budget: b, allowTypes: /text\/html/ });
  assert.equal(r.body, '');
  assert.equal(b.used, b.requestOverhead);
});

// ---------- memory ----------
test('an endless response from a hostile server is cut off at the budget and cannot exhaust memory', async () => {
  global.gc && global.gc();
  const rssBefore = process.memoryUsage().rss; endlessClosed = 0;
  const b = createByteBudget(3 * MB);
  await assert.rejects(guard().request(at('/endless'), { budget: b, maxBytes: 1024 * MB, timeoutMs: 20000 }), (e) => e.code === 'budget-exhausted');
  assert.ok(b.used <= 3 * MB + 256 * KB, `downloaded ${b.used} bytes`);
  const grew = (process.memoryUsage().rss - rssBefore) / MB;
  assert.ok(grew < 60, `memory grew by ${grew.toFixed(1)} MB`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(endlessClosed, 1, 'the connection was closed, not left streaming');
});

// ---------- the crawler ----------
const budgetOver = () => new GuardError('budget-exhausted', '1/1');

test('crawler: when the budget runs out mid-crawl it stops and returns what it has, with a clear marker', async () => {
  const links = Array.from({ length: 30 }, (_, i) => `/p${i}`);
  const pages = { '/': page(html('Home', links)) }; links.forEach((l) => { pages[l] = page(html(l)); });
  const w = web('x', pages); let served = 0;
  const f = { get: w.fetchers.get, getTracked: async (...a) => { if (++served > 6) throw budgetOver(); return w.fetchers.getTracked(...a); } };
  const c = await crawler.crawlSite('https://x.example/', cfgOf(f, { maxTotalBytes: 12345 }));
  assert.equal(c.pages.length, 6);
  assert.equal(c.stopped.reason, 'byte-budget'); assert.equal(c.stopped.pages, 6);
  assert.ok(c.bytes && c.bytes.max > 0);
});

test('crawler: if the budget runs out before a single page was read, the error is controlled and informative', async () => {
  const f = { get: async () => { throw budgetOver(); }, getTracked: async () => { throw budgetOver(); } };
  const e = await crawler.crawlSite('https://x.example/', cfgOf(f)).catch((x) => x);
  assert.ok(e instanceof GuardError); assert.equal(e.code, 'budget-exhausted');
  assert.match(e.message, /larger than our crawl limit/);
  assert.equal(queue.classifyError(e).permanent, true, 'retrying a site that is over the limit cannot help');
});

test('crawler: running out during the link and image checks keeps every page already read', async () => {
  const w = web('x', { '/': page(html('Home', ['/a', '/b', '/gone1', '/gone2'])), '/a': page(html('A')), '/b': page(html('B')) });
  let heads = 0;
  const f = { get: w.fetchers.get, getTracked: async (u, ua, t, method, ...r) => { if (method === 'HEAD' && ++heads > 1) throw budgetOver(); return w.fetchers.getTracked(u, ua, t, method, ...r); } };
  const c = await crawler.crawlSite('https://x.example/', cfgOf(f, { maxPagesPerSite: 2 })); // the other links are only spot-checked with HEAD
  assert.ok(heads >= 2, 'the link-check stage ran'); assert.equal(c.pages.length, 2); assert.equal(c.stopped.reason, 'byte-budget');
});

test('crawler: other errors are not mistaken for budget exhaustion', async () => {
  const f = { get: async () => { throw new Error('unexpected'); }, getTracked: async () => ({ ok: false, status: 0, type: '', body: '', url: 'x', chain: [] }) };
  await assert.rejects(crawler.crawlSite('https://x.example/', cfgOf(f)), /unexpected/);
});

test('crawler: get() and getTracked() let a budget error through instead of hiding it as a failed fetch', async () => {
  const spent = createByteBudget(10); spent.exhausted = true;
  await assert.rejects(crawler.get('https://x.example/', 'ua', 1000, spent), (e) => e.code === 'budget-exhausted');
  await assert.rejects(crawler.getTracked('https://x.example/', 'ua', 1000, 'GET', spent), (e) => e.code === 'budget-exhausted');
  const other = await crawler.get('http://127.0.0.1/', 'ua', 1000, spent); // an invalid address is still an ordinary failed fetch
  assert.equal(other.ok, false);
});

test('the total budget is configurable: per crawl, then environment, then a default; nonsense is ignored', () => {
  const { resolveBudgetBytes, DEFAULT_TOTAL_BYTES } = crawler;
  assert.equal(DEFAULT_TOTAL_BYTES, 100 * MB);
  assert.equal(resolveBudgetBytes({ crawl: { maxTotalBytes: 5000 } }, { CRAWL_MAX_TOTAL_BYTES: '9999' }), 5000);
  assert.equal(resolveBudgetBytes({ crawl: {} }, { CRAWL_MAX_TOTAL_BYTES: '9999' }), 9999);
  assert.equal(resolveBudgetBytes({ crawl: {} }, {}), DEFAULT_TOTAL_BYTES);
  for (const bad of [0, -5, 'abc', NaN, null]) assert.equal(resolveBudgetBytes({ crawl: { maxTotalBytes: bad } }, { CRAWL_MAX_TOTAL_BYTES: bad === null ? undefined : 'x' }), DEFAULT_TOTAL_BYTES, String(bad));
});

test('audit: a crawl that was cut short by the budget is reported as partial, never as complete', async () => {
  const w = web('x', { '/': page(html('Home', ['/a'])), '/a': page(html('A')) });
  const f = { get: w.fetchers.get, getTracked: async (u, ua, t, m) => { if (m === 'HEAD') throw budgetOver(); return w.fetchers.getTracked(u, ua, t, m); } };
  const crawl = await crawler.crawlSite('https://x.example/', cfgOf(f, { maxPagesPerSite: 1 }));
  assert.equal(crawl.stopped.reason, 'byte-budget');
  const a = audit.buildAudit(crawl);
  assert.equal(a.complete, false); assert.equal(a.stopped, 'byte-budget'); assert.equal(a.orphans, null);
  const normal = audit.buildAudit(await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers, { maxPagesPerSite: 1 })));
  assert.equal(normal.stopped, null);
});
