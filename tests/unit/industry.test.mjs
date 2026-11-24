import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { profileMetrics, siteRecord, benchmark, buildFindings, trendOf } = createRequire(import.meta.url)('../../lib/industry.js');

const page = (o = {}) => ({ url: 'https://x.com/p', words: 400, title: 'A good title of the right length here', descLen: 120, h1: ['h'], canonical: true, noindex: false, images: 4, alt: 4, schema: ['Service'], faq: false, inlinks: 3, ms: 500, ...o });
const profile = (pages, o = {}) => ({ pagesCrawled: pages.length, sitemapUrls: 20, llmsTxt: false, avgWords: Math.round(pages.reduce((s, p) => s + p.words, 0) / pages.length), schemaTypes: ['Service'], sameAs: [], brokenLinks: [], heavyImages: [], pages, ...o });
const rich = (words, extra = {}) => profile(Array.from({ length: 10 }, (_, i) => page({ url: 'https://r.com/' + i, words, faq: true, schema: ['FAQPage', 'LocalBusiness', 'BreadcrumbList'], ...extra })), { llmsTxt: true, sitemapUrls: 90, schemaTypes: ['FAQPage', 'LocalBusiness', 'BreadcrumbList', 'Service'], sameAs: ['a', 'b', 'c'] });
const thin = () => profile(Array.from({ length: 10 }, (_, i) => page({ url: 'https://me.com/' + i, words: 180, title: 'Short', descLen: 20, inlinks: i ? 0 : 5, h1: i % 2 ? [] : ['h'], schema: [], ms: 2000 })), { sitemapUrls: 12, schemaTypes: [], brokenLinks: [1, 2, 3], heavyImages: [1] });

test('profileMetrics measures a profile; empty profiles give nothing', () => {
  const m = profileMetrics(profile([page({ words: 200 }), page({ words: 600, title: 'x', descLen: 10, h1: [], schema: [], ms: 2000 })]));
  assert.equal(m.avgWords, 400); assert.equal(m.thinPct, 50); assert.equal(m.titleOkPct, 50); assert.equal(m.descOkPct, 50); assert.equal(m.h1OkPct, 50); assert.equal(m.schemaPct, 50); assert.equal(m.slowPct, 50);
  assert.equal(profileMetrics(null), null); assert.equal(profileMetrics({ pages: [] }), null);
});
test('the benchmark uses the three highest-scoring competitors as top performers and the whole field for the market', () => {
  const others = [['a.com', 90, 1500], ['b.com', 80, 1000], ['c.com', 70, 800], ['d.com', 10, 100], ['e.com', 5, 100]].map(([d, o, w]) => siteRecord(d, o, rich(w)));
  const b = benchmark(siteRecord('me.com', 60, thin()), others);
  assert.deepEqual(b.topSites, ['a.com', 'b.com', 'c.com']);
  assert.equal(b.metrics.avgWords.top, 1000); assert.equal(b.metrics.avgWords.field, 800); assert.equal(b.metrics.avgWords.mine, 180);
  assert.equal(b.metrics.avgWords.nTop, 3); assert.equal(b.metrics.avgWords.nField, 5);
  assert.equal(b.adoption.faqSchema.top, 100); assert.equal(b.adoption.faqSchema.mine, false);
});
test('findings carry numbers, sample sizes and a concrete fix, most severe first', () => {
  const others = [['a.com', 90], ['b.com', 80], ['c.com', 70]].map(([d, o]) => siteRecord(d, o, rich(1100)));
  const { findings, benchmark: b } = buildFindings(siteRecord('me.com', 50, thin()), others);
  const ids = findings.map((f) => f.id);
  for (const id of ['content-depth', 'structured-data', 'faq-coverage', 'snippets', 'headings', 'internal-links', 'speed', 'hygiene', 'feature-llmsTxt', 'feature-faqSchema']) assert.ok(ids.includes(id), id + ' in ' + ids.join());
  const depth = findings.find((f) => f.id === 'content-depth');
  assert.equal(depth.evidence[0].yours, '180 words'); assert.equal(depth.evidence[0].topPerformers, '1,100 words'); assert.equal(depth.evidence[0].sites, 3);
  assert.match(depth.fix, /1100 words/); assert.ok(depth.pages.length > 0);
  assert.equal(b.sites, 3);
  const sev = findings.map((f) => ({ high: 0, medium: 1, low: 2 }[f.severity]));
  assert.deepEqual(sev, [...sev].sort((x, y) => x - y));
});
test('a site that matches the leaders gets no findings for what it already does well', () => {
  const others = [['a.com', 90], ['b.com', 80]].map(([d, o]) => siteRecord(d, o, rich(900)));
  const { findings } = buildFindings(siteRecord('me.com', 95, rich(1000)), others);
  assert.deepEqual(findings, []);
});
test('trend: the same gap is reported as closing, widening or steady against earlier crawls, and the leaders\' movement is shown', () => {
  const others = [siteRecord('a.com', 90, rich(1000))];
  const b = benchmark(siteRecord('me.com', 50, profile([page({ words: 600 })])), others);
  const hist = (mine, top) => ({ day: '2026-11-05', metrics: { avgWords: { mine, top } } });
  assert.equal(trendOf('avgWords', b, [hist(300, 1000)]).direction, 'closing');   // gap was 700, now 400
  assert.equal(trendOf('avgWords', b, [hist(900, 1000)]).direction, 'widening');  // gap was 100, now 400
  assert.equal(trendOf('avgWords', b, [hist(600, 1000)]).direction, 'steady');    // gap was 400, now 400
  assert.equal(trendOf('avgWords', b, [hist(300, 800)]).leadersMoved, 200);
  assert.equal(trendOf('avgWords', b, []), null);
});
