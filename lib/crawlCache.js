// Reads a domain's crawl through the shared cache (supabase/migrations/0005_shared_crawl_cache.sql).
//
//   fresh      -> reuse the stored raw crawl (no network)
//   acquired   -> this caller crawls, stores the result for everyone, and returns it
//   busy       -> another worker is crawling the same domain: wait for it, then reuse its result
//
// The raw crawl is customer-independent. Scoring (customer-specific) happens afterwards, outside this file.
const crypto = require('node:crypto');
const { normalizeDomain } = require('./domains');

// Bump when the SHAPE of crawlSite()'s output changes. Crawl settings are added by the caller (see versionFor).
const CRAWL_FORMAT = 1;
const LEASE_SECONDS = 180; // a crawl holds its domain this long; a crawl takes about a minute (see docs/ARCHITECTURE.md)
const DEFAULT_MAX_AGE_SECONDS = 20 * 3600; // a daily scan always recrawls; same-day requests share one crawl
const versionFor = (settings) => `f${CRAWL_FORMAT}-p${settings.maxPagesPerSite}`;

class CrawlBusyError extends Error {
  constructor(domain) { super('Another crawl of this site is in progress.'); this.name = 'CrawlBusyError'; this.retryable = true; this.code = 'crawl-in-progress'; this.domain = domain; }
}

async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) { const e = new Error(`${fn}: ${error.message}`); e.code = error.code; throw e; }
  return data;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

// db: a Supabase client (service role). crawlFn(domain) -> raw crawl object. buildProfile(crawl) -> small summary for history.
async function getCrawl(db, rawDomain, { crawlFn, buildProfile, settings, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS, waitMs = 45000, pollMs = 3000, sleep = sleepMs }) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) { const e = new Error('Not a valid website name'); e.permanent = true; e.code = 'bad-domain'; throw e; }
  const version = versionFor(settings);
  const deadline = Date.now() + waitMs;

  for (;;) {
    // Acquiring returns a lease token. Finishing or failing needs it, and the database rejects a worker whose lease was replaced
    // or has expired, so a slow worker can never overwrite a newer crawl (migration 0008).
    const acquired = await rpc(db, 'acquire_domain_crawl_lease', { p_domain: domain, p_version: version, p_max_age_seconds: maxAgeSeconds, p_lease_seconds: LEASE_SECONDS });
    const row = Array.isArray(acquired) ? acquired[0] : acquired;
    const state = row && row.state, token = row && row.token;

    if (state === 'fresh') {
      const data = await rpc(db, 'get_domain_crawl', { p_domain: domain, p_version: version });
      if (data) return { crawl: data, source: 'cache' };
      continue; // raced with an invalidation: ask again
    }

    if (state === 'acquired' && token) {
      let crawl;
      try { crawl = await crawlFn(domain); }
      catch (e) { await rpc(db, 'fail_domain_crawl_lease', { p_domain: domain, p_version: version, p_token: token, p_error: String((e && e.message) || e) }).catch(() => {}); throw e; }
      crawl.crawledAt = new Date().toISOString();
      if (!crawl.pages || !crawl.pages.length) {
        // Nothing readable: do not cache an empty result as if it were a good crawl.
        await rpc(db, 'fail_domain_crawl_lease', { p_domain: domain, p_version: version, p_token: token, p_error: 'no pages could be read' }).catch(() => {});
        return { crawl, source: 'crawl', cached: false };
      }
      let profile = null;
      try { profile = buildProfile ? buildProfile(crawl) : null; } catch {}
      const stored = await rpc(db, 'finish_domain_crawl_lease', { p_domain: domain, p_version: version, p_token: token, p_data: crawl, p_pages: crawl.pages.length, p_profile: profile, p_hash: hashOf(crawl.pages.map((p) => [p.url, p.title, p.words])), p_ttl_seconds: maxAgeSeconds });
      // stored is false when this worker's lease had expired or been replaced: the newer result stays, and this caller still
      // gets its own crawl to score from. It is just not shared.
      return { crawl, source: 'crawl', cached: stored === true, stale: stored !== true };
    }

    // busy: someone else holds this domain
    if (Date.now() >= deadline) throw new CrawlBusyError(domain);
    await sleep(pollMs);
  }
}

module.exports = { getCrawl, versionFor, CrawlBusyError, CRAWL_FORMAT, DEFAULT_MAX_AGE_SECONDS, LEASE_SECONDS };
