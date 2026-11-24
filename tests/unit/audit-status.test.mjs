import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildAudit } = createRequire(import.meta.url)('../../lib/audit.js');

const page = (url, extra = {}) => ({ url, requested: url, status: 200, internalLinks: [], title: url, description: url, h1: ['x'], canonical: '', robotsMeta: '', noindex: false, fromSitemap: false, ...extra });
test('the status overview counts 4xx, 5xx, unreachable, noindex, canonical elsewhere and robots-blocked URLs', () => {
  const crawl = {
    pages: [page('https://s.com/', { internalLinks: ['https://s.com/gone', 'https://s.com/boom'] }), page('https://s.com/a', { noindex: true }), page('https://s.com/b', { canonical: 'https://s.com/a' }), page('https://s.com/c', { canonical: '/c' })],
    errors: [{ url: 'https://s.com/gone', status: 404 }, { url: 'https://s.com/boom', status: 503 }, { url: 'https://s.com/slow', status: 'timeout' }, { url: 'https://s.com/f.pdf', status: 200, nonHtml: true }],
    redirects: [{ from: 'https://s.com/old', to: 'https://s.com/a', hops: 1, status: 301 }], brokenLinks: [], blocked: 3, sitemap: { sampled: 0 },
  };
  const a = buildAudit(crawl);
  assert.deepEqual(a.statusOverview, { requested: 8, loaded: 4, redirected3xx: 1, clientError4xx: 1, serverError5xx: 1, unreachable: 1, nonHtml: 1, blockedByRobots: 3, notIndexable: 2 });
  assert.equal(a.clientErrors[0].url, '/gone'); assert.equal(a.clientErrors[0].count, 1);
  assert.equal(a.serverErrors[0].status, 503);
  assert.deepEqual(a.canonicalElsewhere, [{ url: '/b', canonical: '/a' }]);
});
