// Search volume, CPC and competition from Keywords Everywhere (Google Keyword Planner data). Costs paid credits: one per keyword returned.
// Needs KEYWORDS_EVERYWHERE_API_KEY; without it everything here returns nothing and the report simply has no volume column.
// Spend control: results are cached per keyword and country for two weeks (table keyword_volumes, migration 0020), only keywords that are
// missing or stale are requested, and at most MAX_PER_RUN per report. This is DISPLAY data: it never feeds a score.
//
// The host is fixed; keywords go in the request body as form fields, never into the URL.
const API = 'https://api.keywordseverywhere.com/v1/get_keyword_data';
const DAY = 86400000;
const REFRESH_DAYS = 14;
const MAX_PER_RUN = 40;
const clean = (k) => String(k || '').trim().toLowerCase().replace(/\s+/g, ' ');

// One request for up to 100 keywords. Returns Map(keyword -> { volume, cpc, competition, trend }). Never throws.
async function fetchKeywordData(keywords, { env = process.env, fetchFn = globalThis.fetch, country = 'in', signal } = {}) {
  const out = new Map();
  const key = env.KEYWORDS_EVERYWHERE_API_KEY;
  const list = [...new Set(keywords.map(clean).filter((k) => k && k.length <= 120))].slice(0, 100);
  if (!key || !list.length || !/^[a-z]{2}$/.test(country)) return out;
  try {
    const body = new URLSearchParams({ dataSource: 'gkp', country, currency: 'usd' });
    for (const k of list) body.append('kw[]', k);
    const res = await fetchFn(API, { method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual', signal: signal || AbortSignal.timeout(15000) });
    if (!res.ok) return out;
    const json = await res.json();
    for (const r of json.data || []) {
      const k = clean(r.keyword);
      if (!k) continue;
      const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
      out.set(k, { volume: num(r.vol), cpc: num(r.cpc && r.cpc.value), competition: num(r.competition), trend: Array.isArray(r.trend) ? r.trend.slice(-12).map((t) => ({ month: t.month, year: t.year, value: num(t.value) })) : null });
    }
  } catch { /* the report is built without volumes rather than failing */ }
  return out;
}

// Volumes for a project's keywords. `charge(n)` is called before any paid request and may throw (budget): then nothing is requested.
async function keywordDataFor(db, keywords, { country = 'in', charge, ...opts } = {}) {
  const want = [...new Set(keywords.map(clean).filter(Boolean))];
  const result = {};
  if (!want.length) return result;
  const { data: cached } = await db.from('keyword_volumes').select('keyword,volume,cpc,competition,trend,fetched_at').eq('country', country).in('keyword', want);
  const fresh = new Set();
  for (const c of cached || []) {
    result[c.keyword] = { volume: c.volume === null ? null : Number(c.volume), cpc: c.cpc === null ? null : Number(c.cpc), competition: c.competition === null ? null : Number(c.competition), trend: c.trend };
    if (Date.now() - new Date(c.fetched_at).getTime() < REFRESH_DAYS * DAY) fresh.add(c.keyword);
  }
  const todo = want.filter((k) => !fresh.has(k)).slice(0, MAX_PER_RUN);
  if (!todo.length || !(opts.env || process.env).KEYWORDS_EVERYWHERE_API_KEY) return result;
  try { if (charge) await charge(todo.length); } catch { return result; }
  const got = await fetchKeywordData(todo, { country, ...opts });
  if (got.size) {
    const now = new Date().toISOString();
    await db.from('keyword_volumes').upsert([...got].map(([keyword, v]) => ({ keyword, country, volume: v.volume, cpc: v.cpc, competition: v.competition, trend: v.trend, fetched_at: now })), { onConflict: 'keyword,country' });
    for (const [k, v] of got) result[k] = v;
  }
  return result;
}

module.exports = { fetchKeywordData, keywordDataFor, clean };
