// Freshness, Core Web Vitals, share of voice and Google Business Profile summaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crawler from '../../lib/crawl.js';
import { web, html, page, cfgOf } from '../helpers/fakeweb.mjs';
const require = createRequire(import.meta.url);
const { buildProfile, buildFreshness } = require('../../lib/profile.js');
const { parseVitals, collectVitals, isFresh, rate } = require('../../lib/vitals.js');
const { shareOfVoice } = require('../../lib/industry.js');
const { gbpSummary } = require('../../lib/gbp.js');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('a page\'s own modified date is read, absurd and future dates are ignored, and the sitemap lastmod fills in the rest', async () => {
  const withDate = (title, d) => page(html(title, [], `<meta property="article:modified_time" content="${d}">`));
  const w = web('x', { '/': page(html('Home', ['/a', '/b', '/c', '/d'])), '/a': withDate('A', daysAgo(10)), '/b': withDate('B', '1970-01-01'), '/c': withDate('C', '2099-01-01'), '/d': page(html('D')) },
    { sitemap: `<urlset><url><loc>https://x.example/d</loc><lastmod>${daysAgo(400)}</lastmod></url><url><loc>https://x.example/</loc><lastmod>${daysAgo(5)}</lastmod></url></urlset>` });
  const crawl = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  const byUrl = Object.fromEntries(crawl.pages.map((p) => [new URL(p.url).pathname, p.modified]));
  assert.equal(byUrl['/a'], daysAgo(10)); assert.equal(byUrl['/b'], ''); assert.equal(byUrl['/c'], '');
  assert.equal(crawl.sitemapLastmod['https://x.example/d'], daysAgo(400));
  const f = buildFreshness(crawl);
  assert.equal(f.dated, 3); assert.equal(f.newest, daysAgo(5)); assert.equal(f.updated180Pct, 66.7); // /, /a recent; /d old
  assert.equal(buildProfile(crawl).freshness.dated, 3);
});
test('freshness needs at least three dated pages to say anything', () => {
  assert.equal(buildFreshness({ pages: [{ url: 'https://x.example/', modified: daysAgo(1) }, { url: 'https://x.example/a', modified: '' }], sitemapLastmod: {} }), null);
});

test('PageSpeed answers are turned into LCP, CLS, INP and blocking time, preferring real-user figures', () => {
  const body = JSON.stringify({ lighthouseResult: { audits: { 'largest-contentful-paint': { numericValue: 3100 }, 'cumulative-layout-shift': { numericValue: 0.02 }, 'total-blocking-time': { numericValue: 450 } }, categories: { performance: { score: 0.61 } } },
    loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2300 }, INTERACTION_TO_NEXT_PAINT: { percentile: 250 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 } } } });
  const v = parseVitals(body);
  assert.equal(v.lcp, 2300); assert.equal(v.cls, 0.12); assert.equal(v.inp, 250); assert.equal(v.tbt, 450); assert.match(v.source, /real users/);
  assert.deepEqual(v.rating, { lcp: 'good', cls: 'needs-improvement', inp: 'needs-improvement', tbt: 'needs-improvement' });
  const lab = parseVitals(JSON.stringify({ lighthouseResult: { audits: { 'largest-contentful-paint': { numericValue: 5000 } } } }));
  assert.equal(lab.lcp, 5000); assert.equal(lab.source, 'lab test'); assert.equal(lab.inp, null);
  assert.equal(parseVitals('not json'), null); assert.equal(rate('lcp', null), null);
});
test('vitals are only requested with a key and a valid domain, and re-tested at most weekly', async () => {
  let called = 0;
  const getFn = async (url) => { called++; assert.match(url, /^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed\?url=https%3A%2F%2Fexample\.com/); return { ok: true, body: JSON.stringify({ lighthouseResult: { audits: { 'largest-contentful-paint': { numericValue: 1000 } } } }) }; };
  assert.equal(await collectVitals({ domain: 'example.com', key: '', getFn }), null);
  assert.equal(await collectVitals({ domain: 'bad domain/x', key: 'k', getFn }), null);
  assert.equal((await collectVitals({ domain: 'example.com', key: 'k', getFn })).lcp, 1000); assert.equal(called, 1);
  assert.equal(isFresh({ at: new Date().toISOString() }), true); assert.equal(isFresh({ at: new Date(Date.now() - 8 * 86400000).toISOString() }), false); assert.equal(isFresh(null), false);
});

test('share of voice counts each search once per site, using its best position', () => {
  const v = shareOfVoice([{ keyword: 'a', location: 'x', position: 2, domain: 'me.com' }, { keyword: 'a', location: 'x', position: 9, domain: 'me.com' }, { keyword: 'a', location: 'x', position: 5, domain: 'o.com' }, { keyword: 'b', location: 'x', position: 12, domain: 'me.com' }], ['me.com', 'o.com', 'z.com']);
  assert.deepEqual(v, { 'me.com': { pairs: 2, top3: 1, top10: 1 }, 'o.com': { pairs: 2, top3: 0, top10: 1 }, 'z.com': { pairs: 2, top3: 0, top10: 0 } });
});

const place = (position, domain, over = {}) => ({ keyword: 'glass', location: 'pune', position, domain, name: domain.split('.')[0], rating: 4.5, rating_count: 100, category: 'Glazier', phone: '1', ...over });
const brand = (name, domain, over = {}) => ({ keyword: '__brand__', location: name, position: 1, domain, name, rating: 4.4, rating_count: 30, category: 'Glazier', phone: '1', ...over });
test('Business Profile summary: rating, reviews, growth per week, Maps top-3 share, and findings against the leaders', () => {
  const now = [brand('me', 'me.com', { rating_count: 30, rating: 4.1 }), brand('a', 'a.com', { rating_count: 300, rating: 4.8 }), brand('b', 'b.com', { rating_count: 200, rating: 4.7 }), brand('c', 'c.com', { rating_count: 100 }),
    place(1, 'a.com'), place(2, 'b.com'), place(3, 'c.com'), place(7, 'me.com')];
  const prev = [brand('me', 'me.com', { rating_count: 26 }), brand('a', 'a.com', { rating_count: 280 })];
  const s = gbpSummary(now, prev, [{ domain: 'me.com', name: 'me', isMe: true }, { domain: 'a.com', name: 'a' }, { domain: 'b.com', name: 'b' }, { domain: 'c.com', name: 'c' }], { now: '2026-11-17', prev: '2026-11-10' });
  assert.equal(s.me.reviews, 30); assert.equal(s.me.reviewGrowth, 4); assert.equal(s.me.reviewsPerWeek, 4); assert.equal(s.me.top3, 0); assert.equal(s.me.listed, 1);
  assert.equal(s.market.topReviews, 200);
  const ids = s.findings.map((f) => f.id);
  assert.ok(ids.includes('gbp-reviews') && ids.includes('gbp-rating') && ids.includes('gbp-maps-visibility'), ids.join());
  assert.equal(gbpSummary([], [], []), null);
});
test('a business with no listing found gets one clear finding, not a table of blanks', () => {
  const s = gbpSummary([place(1, 'a.com')], [], [{ domain: 'me.com', name: 'me', isMe: true }, { domain: 'a.com', name: 'a' }], { now: '2026-11-17' });
  assert.equal(s.me.found, false); assert.deepEqual(s.findings.map((f) => f.id), ['gbp-missing']);
});
