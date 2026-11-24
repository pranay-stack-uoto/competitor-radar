// Spot check of the full-site audit against an independent, deliberately simple check: fetch every URL in the site's own sitemap with
// plain HTTP (no HTML parsing, no scoring) and compare status codes with what the crawler reported. Needs the network, not the database.
//   node scripts/spot-check.mjs example.com [more.com ...]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { crawlSite } = require('../lib/crawl.js');
const { buildAudit } = require('../lib/audit.js');

const CFG = { maxPagesPerSite: 2000, concurrency: 6, frontierMax: 6000, delayMs: 30, maxMs: 80000, maxTotalBytes: 300 * 1024 * 1024, userAgent: 'CompetitorRadarSpotCheck/1.0' };
const get = async (u) => { try { const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': CFG.userAgent }, signal: AbortSignal.timeout(15000) }); return r; } catch { return null; } };

for (const domain of process.argv.slice(2)) {
  const t = Date.now();
  const crawl = await crawlSite('https://' + domain, { crawl: CFG });
  const audit = buildAudit(crawl);
  const secs = Math.round((Date.now() - t) / 1000);
  // Independent side: sitemap URLs fetched one by one, no redirects followed.
  const urls = (crawl.pages.filter((p) => p.fromSitemap).map((p) => p.requested || p.url)).slice(0, 60);
  const sm = await get('https://' + domain + '/sitemap.xml');
  const statusOf = {};
  let agree = 0, differ = [];
  for (const u of urls) {
    const r = await get(u); const plain = r ? r.status : 0;
    const ours = crawl.pages.find((p) => (p.requested || p.url) === u)?.status;
    statusOf[plain] = (statusOf[plain] || 0) + 1;
    const same = plain === ours || (plain >= 300 && plain < 400 && ours === 200); // we follow redirects, the plain check does not
    if (same) agree++; else differ.push({ u, plain, ours });
  }
  console.log(JSON.stringify({ domain, seconds: secs, complete: audit.complete, stopped: audit.stopped, pages: audit.pages, sitemapUrls: audit.sitemapUrls, status: audit.statusOverview, brokenLinks: audit.broken.length, redirects: audit.redirects.length, noindex: audit.noindex.length, plainCheck: { sample: urls.length, agree, differ: differ.slice(0, 5), codes: statusOf } }, null, 1));
}
