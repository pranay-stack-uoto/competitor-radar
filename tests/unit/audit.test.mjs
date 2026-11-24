import { test } from 'node:test';
import assert from 'node:assert/strict';
import crawler from '../../lib/crawl.js';
import audit from '../../lib/audit.js';
import { web, html, page, cfgOf } from '../helpers/fakeweb.mjs';

const sitemap = (paths) => `<urlset>${paths.map((p) => `<url><loc>https://x.example${p}</loc></url>`).join('')}</urlset>`;

async function audited(pages, opts = {}, cfgOver = {}) {
  const w = web('x', pages, opts);
  const crawl = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers, cfgOver));
  return audit.buildAudit(crawl);
}

test('lists broken links with how many pages point at each, and which', async () => {
  const a = await audited({ '/': page(html('Home', ['/a', '/b', '/gone'])), '/a': page(html('A', ['/gone'])), '/b': page(html('B', ['/gone'])) }, { sitemap: sitemap(['/', '/a', '/b']) });
  assert.equal(a.broken.length, 1);
  assert.deepEqual([a.broken[0].url, a.broken[0].status, a.broken[0].count], ['/gone', 404, 3]);
  assert.deepEqual(a.broken[0].from.sort(), ['/', '/a', '/b']);
});

test('lists links that point at a redirect, with the destination and the linking pages', async () => {
  const a = await audited({ '/': page(html('Home', ['/old'])), '/a': page(html('A', ['/old'])), '/old': { status: 301, location: '/new', headers: {} }, '/new': page(html('New')) }, { sitemap: sitemap(['/', '/a']) });
  assert.equal(a.redirects.length, 1);
  assert.deepEqual([a.redirects[0].url, a.redirects[0].to, a.redirects[0].hops], ['/old', '/new', 1]);
  assert.ok(a.redirects[0].count >= 1);
});

test('finds orphan pages only when most of the sitemap was read', async () => {
  const pages = { '/': page(html('Home', ['/linked'])), '/linked': page(html('L')), '/orphan': page(html('O')) };
  const complete = await audited(pages, { sitemap: sitemap(['/', '/linked', '/orphan']) });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.orphans, ['/orphan']);
  const many = {}; for (let i = 0; i < 20; i++) many[`/p${i}`] = page(html('P' + i));
  const partial = await audited({ '/': page(html('Home')), ...many }, { sitemap: sitemap(['/', ...Object.keys(many)]) }, { maxPagesPerSite: 3 });
  assert.equal(partial.complete, false);
  assert.equal(partial.orphans, null, 'must not claim orphans when most of the site was not read');
});

test('reports noindex pages, duplicate titles and descriptions, and heading problems', async () => {
  const noH1 = '<html><head><title>No heading</title></head><body><p>' + 'word '.repeat(100) + '</p></body></html>';
  const two = '<html><head><title>Two</title></head><body><h1>One</h1><h1>Two</h1><p>' + 'word '.repeat(100) + '</p></body></html>';
  const a = await audited({
    '/': page(html('Home', ['/dup1', '/dup2', '/hid', '/noh1', '/two'])),
    '/dup1': page(html('Same title')), '/dup2': page(html('Same title')),
    '/hid': page(html('Hidden'), { headers: { 'x-robots-tag': 'noindex' } }),
    '/noh1': page(noH1), '/two': page(two),
  }, { sitemap: sitemap(['/', '/dup1', '/dup2', '/hid', '/noh1', '/two']) });
  assert.deepEqual(a.noindex, ['/hid']);
  assert.equal(a.dupTitles.length, 1); assert.equal(a.dupTitles[0].count, 2);
  assert.deepEqual(a.h1Missing, ['/noh1']);
  assert.deepEqual(a.h1Multiple, [{ url: '/two', count: 2 }]);
});

test('output is bounded and JSON-safe', async () => {
  const links = Array.from({ length: 150 }, (_, i) => `/gone${i}`);
  const a = await audited({ '/': page(html('Home', links)) });
  assert.ok(a.broken.length <= 100);
  assert.doesNotThrow(() => JSON.stringify(a));
  assert.ok(JSON.stringify(a).length < 200_000);
});

// Orphans need at least three sitemap pages to mean anything, so a two-page site reports null (unknown), never a guess.
test('a tiny site: orphans are unknown, not guessed', async () => {
  const a = await audited({ '/': page(html('Home', ['/a'])), '/a': page(html('About')) }, { sitemap: sitemap(['/', '/a']) });
  assert.equal(a.orphans, null);
});

test('a clean site reports nothing to fix', async () => {
  const a = await audited({ '/': page(html('Home', ['/a', '/b'])), '/a': page(html('About', ['/'])), '/b': page(html('Blog', ['/'])) }, { sitemap: sitemap(['/', '/a', '/b']) });
  assert.deepEqual([a.broken, a.redirects, a.noindex, a.orphans, a.dupTitles, a.h1Missing, a.h1Multiple], [[], [], [], [], [], [], []]);
});
