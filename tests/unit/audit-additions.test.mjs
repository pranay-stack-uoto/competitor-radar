// Additions made after comparing with Ahrefs Site Audit: host variants, health, changes, AI bots, schema coverage, timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crawler from '../../lib/crawl.js';
import audit from '../../lib/audit.js';
import robots from '../../lib/robots.js';
import { web, html, page, cfgOf } from '../helpers/fakeweb.mjs';

const sitemap = (paths) => `<urlset>${paths.map((p) => `<url><loc>https://x.example${p}</loc></url>`).join('')}</urlset>`;
const crawlOf = async (pages, opts = {}, cfgOver = {}) => crawler.crawlSite('https://x.example/', cfgOf(web('x', pages, opts).fetchers, cfgOver));

test('links written with another host or http are found, resolved to where they end up, and counted per page', async () => {
  const w = web('x', { '/': page(html('Home', ['/a'], '<a href="https://www.x.example/b">b</a><a href="http://x.example/a">a</a>')), '/a': page(html('A', [], '<a href="https://www.x.example/b">b</a>')), '/b': page(html('B')) });
  // The fake web only knows host x.example; www.x.example must be reached through the same fetchers, so the variant answers as a redirect.
  const fetchers = { ...w.fetchers };
  const crawl = await crawler.crawlSite('https://x.example/', cfgOf(fetchers, { hostCheck: true }));
  const home = crawl.pages[0];
  assert.ok(home.altHostLinks.some((l) => l.startsWith('https://www.x.example/b')), home.altHostLinks.join());
  assert.ok(home.altHostLinks.some((l) => l.startsWith('http://x.example/a')));
  assert.ok(crawl.hostVariants && crawl.hostVariants.targets.length >= 1);
  const a = audit.buildAudit(crawl);
  assert.ok(a.hostIssues.pagesLinking >= 1);
  assert.ok(a.issues.some((i) => i.id === 'host-variant-links'));
});
test('without hostCheck (competitor crawls) no extra requests are made for host variants', async () => {
  const w = web('x', { '/': page(html('Home', [], '<a href="https://www.x.example/b">b</a>')) });
  const crawl = await crawler.crawlSite('https://x.example/', cfgOf(w.fetchers));
  assert.equal(crawl.hostVariants, undefined);
});

test('health score, severity counts and the issue list come from the same facts', async () => {
  const crawl = await crawlOf({ '/': page(html('Home', ['/a', '/gone'])), '/a': page(html('A', ['/gone'])) }, { sitemap: sitemap(['/', '/a']) });
  const a = audit.buildAudit(crawl);
  const ids = a.issues.map((i) => i.id);
  assert.ok(ids.includes('broken-pages') && ids.includes('links-to-broken'), ids.join());
  assert.equal(a.issues.find((i) => i.id === 'links-to-broken').count, 2); // two pages carry a broken link
  assert.equal(a.severity.error >= 3, true);
  assert.equal(a.health, Math.round(((a.statusOverview.requested - 3) / a.statusOverview.requested) * 100)); // /gone + the two linking pages
});
test('changes since the last crawl: new issues, fixed issues, and unchanged ones are left out', () => {
  const was = [{ id: 'broken-pages', severity: 'error', label: 'L', count: 2, urls: ['/a', '/b'] }, { id: 'orphans', severity: 'warning', label: 'O', count: 1, urls: ['/o'] }, { id: 'noindex', severity: 'notice', label: 'N', count: 1, urls: ['/n'] }];
  const now = [{ id: 'broken-pages', severity: 'error', label: 'L', count: 2, urls: ['/b', '/c'] }, { id: 'noindex', severity: 'notice', label: 'N', count: 1, urls: ['/n'] }, { id: 'h1-missing', severity: 'warning', label: 'H', count: 1, urls: ['/h'] }];
  const d = audit.diffIssues(was, now);
  const by = Object.fromEntries(d.map((r) => [r.id, r]));
  assert.deepEqual([by['broken-pages'].added, by['broken-pages'].resolved], [['/c'], ['/a']]);
  assert.equal(by.orphans.now, 0); assert.deepEqual(by.orphans.resolved, ['/o']);
  assert.deepEqual(by['h1-missing'].added, ['/h']);
  assert.equal(by.noindex, undefined);
  assert.equal(audit.diffIssues(null, now), null);
});

test('AI crawler access is read from robots.txt per bot, with a bot\'s own group winning over *', () => {
  const r = robots.parseRobots('User-agent: GPTBot\nDisallow: /\nUser-agent: Claude-SearchBot\nAllow: /\nUser-agent: *\nDisallow: /');
  const by = Object.fromEntries(robots.aiBotAccess(r).map((b) => [b.bot, b.allowed]));
  assert.equal(by.GPTBot, false); assert.equal(by['Claude-SearchBot'], true); assert.equal(by.PerplexityBot, false); // "*" blocks everything not named
  assert.equal(robots.aiBotAccess(robots.parseRobots('')).every((b) => b.allowed), true);
});

test('structured data is checked per page type, and Organization markup completeness on the home page', () => {
  const P = [
    { url: 'https://x.example/', ldTypes: ['Organization'], ld: [{ '@type': 'Organization', name: 'X', url: 'https://x.example' }], internalLinks: [] },
    { url: 'https://x.example/blog/one', ldTypes: [], ld: [], internalLinks: [] },
    { url: 'https://x.example/blog/two', ldTypes: ['BlogPosting'], ld: [], internalLinks: [] },
    { url: 'https://x.example/faq', ldTypes: [], ld: [], internalLinks: [] },
  ];
  const c = Object.fromEntries(audit.schemaCoverage(P).map((x) => [x.type, x]));
  assert.deepEqual([c.home.pages, c.home.covered], [1, 1]); assert.deepEqual([c.article.pages, c.article.covered], [2, 1]); assert.deepEqual(c.article.missing, ['/blog/one']);
  assert.deepEqual([c.faq.pages, c.faq.covered], [1, 0]);
  assert.deepEqual(audit.orgSchema(P[0]).missing, ['logo', 'address', 'telephone', 'sameAs']);
  assert.equal(audit.orgSchema({ ld: [] }).found, false);
});

test('server speed is summarised from pages fetched one at a time: median response, size, compression, buckets', () => {
  const t = (ttfb, total, kb, enc) => ({ url: `https://x.example/${ttfb}`, ttfb, total, bytes: kb * 1024, enc });
  const p = audit.performanceSample([t(100, 300, 50, 'br'), t(300, 900, 100, 'gzip'), t(800, 2000, 400, '')]);
  assert.deepEqual([p.sampled, p.medianTtfb, p.medianTotal, p.medianKB, p.compressedPct], [3, 300, 900, 100, 67]);
  assert.deepEqual(p.ttfb, { fast: 1, ok: 1, slow: 1 }); assert.equal(p.slowest[0].ttfb, 800); assert.equal(p.uncompressed.length, 1);
  assert.equal(audit.performanceSample([]), null);
});
test('the crawler records response timing, and a timing sample is taken one request at a time when asked', async () => {
  const crawl = await crawlOf({ '/': page(html('Home', ['/a'])), '/a': page(html('A')) }, {}, { timingSample: 2 });
  assert.equal(crawl.timing.length, 2);
  assert.ok(crawl.timing.every((x) => typeof x.url === 'string'));
});

test('attachHistory adds the changes since the previous audit and the health trend, and copes with no history or old-format audits', () => {
  const now = { issues: [{ id: 'broken-pages', severity: 'error', label: 'L', count: 1, urls: ['/b'] }] };
  const earlier = [{ day: '2026-11-10', data: { health: 81, issues: [{ id: 'broken-pages', severity: 'error', label: 'L', count: 2, urls: ['/a', '/b'] }] } }, { day: '2026-11-09', data: { health: 70 } }, { day: '2026-11-08', data: {} }];
  const a = audit.attachHistory({ ...now }, earlier);
  assert.equal(a.changesSince, '2026-11-10'); assert.deepEqual(a.changes[0].resolved, ['/a']);
  assert.deepEqual(a.healthHistory, [{ day: '2026-11-09', health: 70 }, { day: '2026-11-10', health: 81 }]);
  const first = audit.attachHistory({ ...now }, []);
  assert.deepEqual([first.changes, first.changesSince, first.healthHistory], [null, null, []]);
  assert.equal(audit.attachHistory({ ...now }, [{ day: '2026-11-10', data: { health: 80 } }]).changes, null); // an audit stored before issue lists existed
});
