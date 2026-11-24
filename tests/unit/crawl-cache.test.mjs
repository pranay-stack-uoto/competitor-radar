// The cache orchestration (lib/crawlCache.js) running against the real SQL functions, plus scoring determinism from cached data.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, asSupabase } from '../helpers/db.mjs';
import cache from '../../lib/crawlCache.js';
import queue from '../../lib/queue.js';
import domains from '../../lib/domains.js';
import crawler from '../../lib/crawl.js';
import seo from '../../lib/modules/seo.js';
import geo from '../../lib/modules/geo.js';
import local from '../../lib/modules/local.js';
import keywords from '../../lib/modules/keywords.js';

const { getCrawl, versionFor, CrawlBusyError } = cache;
const { normalizeDomain } = domains;
const settings = { maxPagesPerSite: 40 };
const fakeCrawl = (domain) => ({ origin: 'https://' + domain, pages: [{ url: `https://${domain}/`, title: 'T', words: 10 }], errors: [], robotsTxt: '', llmsTxt: false });

let db, sb, calls;
before(async () => { db = await createDb(); sb = asSupabase(db); });
beforeEach(async () => { await db.exec('delete from public.domain_crawls; delete from public.domain_crawl_snapshots'); calls = []; });
const opts = (extra = {}) => ({ settings, buildProfile: () => ({ ok: true }), pollMs: 15, waitMs: 2000, crawlFn: async (d) => { calls.push(d); await new Promise((r) => setTimeout(r, 40)); return fakeCrawl(d); }, ...extra });

test('normalizeDomain accepts ordinary sites in any spelling and rejects everything else', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path?x=1'), 'example.com');
  assert.equal(normalizeDomain('Example.COM.'), 'example.com');
  assert.equal(normalizeDomain('  sub.example.co.in  '), 'sub.example.co.in');
  for (const bad of ['', null, undefined, 'localhost', 'http://127.0.0.1', 'http://[::1]/', 'a b', 'file:///etc/passwd', 'x'.repeat(3000), 'example', 'foo.internal', 'user@example.com', 'example.com:8080', 'https://user:pw@example.com']) assert.equal(normalizeDomain(bad), null, String(bad));
});

test('first request crawls and stores; the second is served from the cache with no crawl', async () => {
  const a = await getCrawl(sb, 'https://www.A.example.com/x', opts());
  assert.equal(a.source, 'crawl'); assert.equal(calls.length, 1); assert.equal(calls[0], 'a.example.com');
  const b = await getCrawl(sb, 'a.example.com', opts());
  assert.equal(b.source, 'cache'); assert.equal(calls.length, 1);
  assert.equal(b.crawl.pages[0].url, 'https://a.example.com/');
  assert.ok(b.crawl.crawledAt);
});

test('two customers asking at the same moment cause exactly one crawl', async () => {
  const results = await Promise.all([getCrawl(sb, 'dup.example.com', opts()), getCrawl(sb, 'dup.example.com', opts()), getCrawl(sb, 'dup.example.com', opts())]);
  assert.equal(calls.length, 1);
  assert.deepEqual(results.map((r) => r.source).sort(), ['cache', 'cache', 'crawl']);
});

test('if the crawl in progress never finishes, the waiter gives up with a retryable error (the job is retried later)', async () => {
  await db.query(`select public.acquire_domain_crawl('slow.example.com', $1, 3600)`, [versionFor(settings)]);
  const e = await getCrawl(sb, 'slow.example.com', opts({ waitMs: 120, pollMs: 20 })).catch((x) => x);
  assert.ok(e instanceof CrawlBusyError);
  assert.equal(queue.classifyError(e).permanent, false);
  assert.equal(calls.length, 0);
});

test('STALE WORKER through getCrawl: a worker whose lease expired mid-crawl cannot overwrite the newer worker\'s cached result', async () => {
  let releaseSlow;
  const slowGate = new Promise((r) => { releaseSlow = r; });
  // Worker A starts crawling and is held up.
  const slow = getCrawl(sb, 'race.example.com', opts({ crawlFn: async (d) => { calls.push('A'); await slowGate; const c = fakeCrawl(d); c.pages[0].title = 'FROM-A'; return c; } }));
  await new Promise((r) => setTimeout(r, 60));
  // A's lease runs out while it is still working, so worker B takes over and finishes first.
  await db.query(`update public.domain_crawls set lease_expires_at = now() - interval '1 second' where domain = 'race.example.com'`);
  const b = await getCrawl(sb, 'race.example.com', opts({ crawlFn: async (d) => { calls.push('B'); const c = fakeCrawl(d); c.pages[0].title = 'FROM-B'; return c; } }));
  assert.equal(b.cached, true);
  // Now A finally finishes.
  releaseSlow();
  const a = await slow;
  assert.equal(a.cached, false, 'the stale worker\'s result must not be stored');
  assert.equal(a.stale, true);
  assert.equal(a.crawl.pages[0].title, 'FROM-A', 'but it still returns its own crawl to its caller');
  const stored = await getCrawl(sb, 'race.example.com', opts());
  assert.equal(stored.source, 'cache'); assert.equal(stored.crawl.pages[0].title, 'FROM-B', 'everyone else gets the newer result');
  assert.equal(Number((await db.query(`select count(*) n from public.domain_crawl_snapshots where domain = 'race.example.com'`)).rows[0].n), 1);
});

test('a failed crawl is reported, releases the domain, and the next caller tries again', async () => {
  await assert.rejects(getCrawl(sb, 'bad.example.com', opts({ crawlFn: async () => { throw new Error('boom'); } })), /boom/);
  assert.equal((await db.query(`select status from public.domain_crawls`)).rows[0].status, 'failed');
  const r = await getCrawl(sb, 'bad.example.com', opts());
  assert.equal(r.source, 'crawl');
});

test('an empty crawl (nothing readable) is returned to the caller but never cached', async () => {
  const empty = opts({ crawlFn: async (d) => { calls.push(d); return { origin: 'https://e.example.com', pages: [], errors: [] }; } });
  const r = await getCrawl(sb, 'e.example.com', empty);
  assert.equal(r.crawl.pages.length, 0); assert.equal(r.cached, false);
  const again = await getCrawl(sb, 'e.example.com', empty);
  assert.equal(calls.length, 2); assert.equal(again.source, 'crawl');
});

test('an invalid domain is a permanent error and nothing is crawled', async () => {
  const e = await getCrawl(sb, 'localhost', opts()).catch((x) => x);
  assert.equal(queue.classifyError(e).permanent, true);
  assert.equal(calls.length, 0);
});

test('recheck: invalidating the owner\'s domain makes the next request crawl again', async () => {
  await getCrawl(sb, 'own.example.com', opts());
  await queue.invalidateCrawl(sb, 'own.example.com');
  const r = await getCrawl(sb, 'own.example.com', opts());
  assert.equal(r.source, 'crawl'); assert.equal(calls.length, 2);
});

test('history: each real crawl leaves a snapshot with the profile', async () => {
  await getCrawl(sb, 'h.example.com', opts());
  await queue.invalidateCrawl(sb, 'h.example.com');
  await getCrawl(sb, 'h.example.com', opts());
  const rows = (await db.query(`select profile from public.domain_crawl_snapshots where domain = 'h.example.com'`)).rows;
  assert.equal(rows.length, 2); assert.deepEqual(rows[0].profile, { ok: true });
});

test('the real queue wrapper works against the real SQL functions', async () => {
  const { p1 } = await (await import('../helpers/db.mjs')).seedTwoTenants(db);
  await db.exec('delete from public.jobs'); // the seed adds its own queued jobs
  const id = await queue.enqueue(sb, { projectId: p1, day: '2026-11-05', kind: 'crawl', domain: 'Q.example.com' });
  assert.ok(id);
  assert.equal(await queue.enqueue(sb, { projectId: p1, day: '2026-11-05', kind: 'crawl', domain: 'q.example.com' }), null);
  const job = await queue.claim(sb, 'w1');
  assert.equal(String(job.id), String(id)); assert.equal(job.domain, 'q.example.com');
  assert.equal(await queue.fail(sb, job, new Error('connection reset'), 'w1'), 'queued');
  assert.equal(await queue.claim(sb, 'w1'), null); // backing off
  await db.query('update public.jobs set run_after = now()');
  const again = await queue.claim(sb, 'w1');
  assert.equal(again.attempts, 2);
  assert.equal(await queue.complete(sb, again, 'w1'), true);
  assert.equal(await queue.recoverExpired(sb), 0);
});

// ---- scoring must not care whether the crawl came from the network or from the cache ----
const PAGE = (title, body, extra = '') => `<html lang="en"><head><title>${title}</title><meta name="description" content="${body.slice(0, 120)}"><meta name="viewport" content="width=device-width">
  <link rel="canonical" href="https://shop.example.com/"><meta property="og:title" content="x"><script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Shop","address":{"streetAddress":"12 Main Road","addressLocality":"Pune"},"areaServed":"Pune","sameAs":["https://facebook.com/shop"]}</script></head>
  <body><h1>${title}</h1><h2>Why us?</h2><p>${body}</p><h2>Contact</h2><a href="tel:+911234567890">Call +91 12345 67890</a><img src="/a.jpg" alt="shop"><img src="/b.jpg">${extra}</body></html>`;
const SITE = [['Plumber in Pune | Shop', 'We are a plumbing company serving Pune and Mumbai with leak repair, pipe fitting and bathroom plumbing. '.repeat(12)], ['Contact our Pune office', 'Visit 12 Main Road, Pune 411001. Call us today for plumber services in Pune. '.repeat(8), '<a href="/">home</a>']];

test('scores computed from a crawl that went through the cache (JSON round trip) are identical to scores from the live crawl object', async () => {
  const live = { origin: 'https://shop.example.com', robotsTxt: 'User-agent: *\nAllow: /', robots: crawler.parseRobots('User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml'), llmsTxt: true,
    sitemap: { found: true, count: 2, sampled: 2 }, errors: [], redirects: [], brokenLinks: [], linkCheck: { targets: 3, verified: 0 }, imageSample: [{ url: 'https://shop.example.com/a.jpg', bytes: 50000 }],
    pages: SITE.map(([t, b, x], i) => ({ ...crawler.analyzePage(PAGE(t, b, x), `https://shop.example.com/${i ? 'contact' : ''}`), ms: 120, status: 200, https: true, noindex: false, redirectHops: 0, fromSitemap: true, requested: `https://shop.example.com/${i ? 'contact' : ''}` })) };
  const cached = JSON.parse(JSON.stringify(live));
  const cfg = { keywords: ['plumber pune', 'bathroom plumbing'], locations: ['Pune'], aiPrompts: [] };
  const ctx = { site: { name: 'shop.example.com' }, pagespeed: false, serpRanks: { 'plumber pune|Pune': 3, 'bathroom plumbing|Pune': 0 } };
  for (const [name, mod] of Object.entries({ seo, geo, local, keywords })) {
    const a = await mod(live, cfg, ctx), b = await mod(cached, cfg, ctx);
    assert.deepEqual(b, a, name);
    assert.ok(Number.isFinite(a.score), name);
  }
});
