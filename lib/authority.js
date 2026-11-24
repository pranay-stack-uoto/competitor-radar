// Link-based authority from Open PageRank (free API, a 0 to 10 score derived from Common Crawl's link graph). It is a different measure from
// Ahrefs' Domain Rating: use it to compare sites with each other, never to quote a number as "DR". Needs OPENPAGERANK_API_KEY; without
// it everything here returns nothing and the report simply has no authority column.
//
// The host is fixed and only domain names (validated) go into the query, so this never fetches a URL a user or a page could steer.
const API = 'https://openpagerank.com/api/v1.0/getPageRank';
const DAY = 86400000;
const REFRESH_DAYS = 7;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Calls the API for up to 100 domains. Returns Map(domain -> { pageRank, globalRank }). Never throws.
async function fetchAuthority(domains, { env = process.env, fetchFn = globalThis.fetch, signal } = {}) {
  const out = new Map();
  const key = env.OPENPAGERANK_API_KEY;
  const list = [...new Set(domains.map((d) => String(d).toLowerCase()).filter((d) => DOMAIN.test(d)))].slice(0, 100);
  if (!key || !list.length) return out;
  try {
    const url = API + '?' + list.map((d) => 'domains[]=' + encodeURIComponent(d)).join('&');
    const res = await fetchFn(url, { headers: { 'API-OPR': key }, redirect: 'manual', signal: signal || AbortSignal.timeout(10000) });
    if (!res.ok) return out;
    const body = await res.json();
    for (const r of body.response || []) {
      if (r.status_code !== 200 || !r.domain) continue;
      const pr = Number(r.page_rank_decimal);
      out.set(String(r.domain).toLowerCase(), { pageRank: Number.isFinite(pr) ? Math.round(pr * 100) / 100 : null, globalRank: Number(r.rank) > 0 ? Number(r.rank) : null });
    }
  } catch { /* the report is built without authority rather than failing */ }
  return out;
}

// Authority for a set of domains: cached rows younger than a week are used, the rest are fetched once and stored.
async function authorityFor(db, domains, opts = {}) {
  const want = [...new Set(domains.map((d) => String(d).toLowerCase()))];
  const result = {};
  if (!want.length) return result;
  const { data: cached } = await db.from('domain_authority').select('domain,page_rank,global_rank,fetched_at').in('domain', want);
  const fresh = new Set();
  for (const c of cached || []) {
    if (Date.now() - new Date(c.fetched_at).getTime() < REFRESH_DAYS * DAY) { fresh.add(c.domain); result[c.domain] = { pageRank: c.page_rank === null ? null : Number(c.page_rank), globalRank: c.global_rank === null ? null : Number(c.global_rank) }; }
  }
  const stale = want.filter((d) => !fresh.has(d));
  if (!stale.length) return result;
  const got = await fetchAuthority(stale, opts);
  if (got.size) {
    const rows = [...got].map(([domain, v]) => ({ domain, page_rank: v.pageRank, global_rank: v.globalRank, fetched_at: new Date().toISOString() }));
    await db.from('domain_authority').upsert(rows, { onConflict: 'domain' });
    for (const [domain, v] of got) result[domain] = v;
  }
  return result;
}

module.exports = { fetchAuthority, authorityFor, DOMAIN };
