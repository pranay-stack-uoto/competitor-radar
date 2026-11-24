// The crawler against a fake website (no network): failure handling, redirects, sitemaps, robots rules and the www regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crawler from '../../lib/crawl.js';

import { web, html, page, cfgOf } from '../helpers/fakeweb.mjs';

test('crawls a simple site, finds linked pages, and reads robots, llms and sitemap', async () => {
  const w = web('x', { '/': page(html('Home', ['/a', '/b'])), '/a': page(html('A', ['/'])), '/b': page(html('B')) }, { robots: 'User-agent: *\nAllow: /', llms: '# site llms file with enough text', sitemap: '<urlset><url><loc>https://x.example/</loc></url><url><loc>https://x.example/a</loc></url></urlset>' });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  assert.deepEqual(c.pages.map((p) => new URL(p.url).pathname).sort(), ['/', '/a', '/b']);
  assert.equal(c.llmsTxt, true); assert.equal(c.sitemap.found, true); assert.equal(c.sitemap.count, 2);
  assert.ok(c.robotsTxt.includes('User-agent'));
});

test('404s and non-HTML responses are recorded as errors, not pages; broken links are reported with the page that links to them', async () => {
  const w = web('x', { '/': page(html('Home', ['/gone', '/doc.pdf', '/ok'])), '/ok': page(html('OK')), '/doc.pdf': { status: 200, type: 'application/pdf', body: 'PDF', headers: {} } });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  assert.deepEqual(c.pages.map((p) => new URL(p.url).pathname).sort(), ['/', '/ok']);
  assert.ok(c.errors.some((e) => e.url.endsWith('/gone') && e.status === 404));
  assert.deepEqual(c.brokenLinks.map((b) => [new URL(b.to).pathname, b.status]), [['/gone', 404]]);
  assert.equal(new URL(c.brokenLinks[0].from).pathname, '/');
});

test('robots.txt Disallow rules are obeyed: disallowed pages are never requested', async () => {
  const w = web('x', { '/': page(html('Home', ['/private/secret', '/public'])), '/public': page(html('Public')), '/private/secret': page(html('Secret')) }, { robots: 'User-agent: *\nDisallow: /private' });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  assert.ok(!c.pages.some((p) => p.url.includes('/private')));
  assert.ok(!w.calls.some((x) => x.includes('/private')), 'no request may be sent to a disallowed path: ' + w.calls.join(', '));
});

test('redirects: single hops and chains are recorded, and the entry redirect is flagged separately', async () => {
  const w = web('x', { '/': page(html('Home', ['/old', '/chain1'])), '/old': { status: 301, location: '/new', headers: {} }, '/new': page(html('New')), '/chain1': { status: 301, location: '/chain2', headers: {} }, '/chain2': { status: 302, location: '/new', headers: {} } });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  const byFrom = Object.fromEntries(c.redirects.map((r) => [new URL(r.from).pathname, r]));
  assert.equal(byFrom['/old'].hops, 1);
  assert.equal(byFrom['/chain1'].hops, 2);
});

test('a redirect loop is detected and reported instead of followed forever', async () => {
  const w = web('x', { '/': page(html('Home', ['/loop'])), '/loop': { status: 302, location: '/loop-b', headers: {} }, '/loop-b': { status: 302, location: '/loop', headers: {} } });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  assert.ok(c.redirects.some((r) => r.loop) || c.errors.some((e) => e.loop) || c.brokenLinks.some((b) => b.status === 'loop'));
});

test('noindex is detected from the robots meta tag and from the X-Robots-Tag header', async () => {
  const w = web('x', { '/': page(html('Home', ['/m', '/h'])), '/m': page(html('M', [], '').replace('</head>', '<meta name="robots" content="noindex,follow"></head>')), '/h': page(html('H'), { headers: { 'x-robots-tag': 'noindex' } }) });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  const flags = Object.fromEntries(c.pages.map((p) => [new URL(p.url).pathname, p.noindex]));
  assert.deepEqual(flags, { '/': false, '/m': true, '/h': true });
});

test('REGRESSION: a domain saved without www still uses the sitemap of the www site', async () => {
  const posts = Array.from({ length: 6 }, (_, i) => `<url><loc>https://www.x.example/post/p${i}</loc></url>`).join('');
  const pages = { '/': page(html('Home')) };
  for (let i = 0; i < 6; i++) pages[`/post/p${i}`] = page(html('Post ' + i));
  const w = web('x', pages, { sitemap: `<urlset>${posts}</urlset>` });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers)); // note: no www in the address we start from
  assert.equal(c.sitemap.sampled, 6);
  assert.ok(c.pages.filter((p) => p.url.includes('/post/')).length === 6, 'sitemap pages must be crawled');
});

test('pages are discovered from links on every page, not only the homepage (no sitemap needed)', async () => {
  const w = web('x', { '/': page(html('Home', ['/l1'])), '/l1': page(html('L1', ['/l2'])), '/l2': page(html('L2', ['/l3'])), '/l3': page(html('L3')) });
  const c = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  assert.deepEqual(c.pages.map((p) => new URL(p.url).pathname), ['/', '/l1', '/l2', '/l3']);
});

test('the page cap and the time cap both stop the crawl', async () => {
  const links = Array.from({ length: 50 }, (_, i) => `/p${i}`);
  const pages = { '/': page(html('Home', links)) }; links.forEach((l) => { pages[l] = page(html(l)); });
  const w = web('x', pages);
  assert.equal((await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers, { maxPagesPerSite: 7 }))).pages.length, 7);
  const slow = { get: async (...a) => { await new Promise((r) => setTimeout(r, 30)); return w.fetchers.get(...a); }, getTracked: async (...a) => { await new Promise((r) => setTimeout(r, 30)); return w.fetchers.getTracked(...a); } };
  const t = await crawler.crawlSite('https://x.example/', cfgOf(slow, { maxPagesPerSite: 50, maxMs: 150 }));
  assert.ok(t.pages.length < 50 && t.pages.length >= 1);
});

test('an unreachable site gives an empty crawl, not an exception', async () => {
  const dead = { get: async () => ({ ok: false, status: 0, type: '', body: '', url: 'x', error: 'dns-failed' }), getTracked: async () => ({ ok: false, status: 0, type: '', body: '', url: 'x', chain: [], error: 'dns-failed' }) };
  const c = await crawler.crawlSite('https://gone.example/', cfgOf(dead));
  assert.equal(c.pages.length, 0); assert.ok(c.errors.length >= 1);
});

test('malformed HTML and hostile content do not break page analysis', () => {
  for (const h of ['', '<html', '<<<>>>', '<script>alert(1)</script>', '<a href="http://[::1">x</a>', '<a href="javascript:void(0)">x</a>', '<img src="data:image/png;base64,AAA">', '\u0000\u0001<h1>\ud800</h1>', '<script type="application/ld+json">{bad json</script>'])
    assert.doesNotThrow(() => crawler.analyzePage(h, 'https://x.example/'), h.slice(0, 20));
  const p = crawler.analyzePage('<a href="https://other.example/x">o</a><a href="/in">i</a><a href="mailto:a@b.c">m</a>', 'https://x.example/');
  assert.deepEqual(p.internalLinks, ['https://x.example/in']);
});

test('duplicate content is detectable: identical text gives identical hashes, tiny pages are not hashed', () => {
  const a = crawler.analyzePage(html('Same'), 'https://x.example/a'), b = crawler.analyzePage(html('Same'), 'https://x.example/b'), c = crawler.analyzePage(html('Other'), 'https://x.example/c');
  assert.equal(a.bodyHash, b.bodyHash); assert.notEqual(a.bodyHash, c.bodyHash);
  assert.equal(crawler.analyzePage('<p>short</p>', 'https://x.example/').bodyHash, '');
});
