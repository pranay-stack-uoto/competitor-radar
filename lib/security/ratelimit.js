// Per-user rate limiting backed by Postgres (supabase/migrations/0003_rate_limits.sql). Pure logic, no framework imports,
// so it is easy to test.
//
// FAIL CLOSED: if the limiter cannot give a clear yes, the request is refused. In particular a missing rate_limit_hit()
// function (migration not applied) returns HTTP 503 in production instead of quietly letting everything through.
// Only when NODE_ENV is explicitly "development" or "test" is an in-memory fallback used, and it says so in the log.
const { HttpError } = require('./validate');

// Per user, fixed windows. These protect search, AI and crawl spend.
const LIMITS = Object.freeze({
  extract: { max: 6, windowSec: 3600 },
  verify: { max: 30, windowSec: 3600 },
  insights: { max: 6, windowSec: 3600 },
  competitorAdd: { max: 30, windowSec: 86400 },
  nudge: { max: 240, windowSec: 3600 },
  projectStart: { max: 20, windowSec: 86400 },
  gsc: { max: 20, windowSec: 3600 },
});

// Per client address, across every API route: stops floods and enumeration that a per-user limit cannot see (it also covers requests that
// fail authentication). Generous on purpose: many people can share one office address. Edge limits (Vercel Firewall) are the next layer.
const IP_LIMIT = Object.freeze({ max: 300, windowSec: 600 });
// The address as seen by the platform (Vercel sets these itself and overwrites any value a client sends). Returned hashed so
// raw addresses are not stored in the rate-limit table. null when it cannot be determined (then no per-IP limit applies).
function ipKey(headers) {
  const get = (n) => (headers && typeof headers.get === 'function' ? headers.get(n) : (headers || {})[n]);
  const raw = String(get('x-real-ip') || String(get('x-forwarded-for') || '').split(',')[0] || '').trim();
  if (!raw || raw.length > 64 || !/^[0-9a-fA-F:.]+$/.test(raw)) return null;
  return 'ip:' + require('node:crypto').createHash('sha256').update('radar-ip:' + raw).digest('hex').slice(0, 24);
}

// Anything that is not explicitly development or test is treated as production, so a missing or unusual NODE_ENV cannot open the gate.
const isProduction = (env) => !['development', 'test'].includes(String(env.NODE_ENV || ''));

const isMissingFunction = (error) => !!error && (error.code === 'PGRST202' || error.code === '42883' || /could not find the function|function .* does not exist/i.test(String(error.message || '')));

// Development and test only. Per process, fixed windows, lost on restart. Never used in production.
const devMemory = new Map();
let devWarned = false;
function devFallback({ key, windowSec, max, now, memory, log }) {
  if (!devWarned) { devWarned = true; log('rate limiting: migration 0003 is missing, using the in-memory DEVELOPMENT fallback (never used in production)'); }
  const windowStart = Math.floor(now() / 1000 / windowSec) * windowSec;
  const k = `${key}@${windowStart}`;
  const hits = (memory.get(k) || 0) + 1;
  memory.set(k, hits);
  for (const old of memory.keys()) if (Number(old.split('@')[1]) < windowStart - 2 * windowSec) memory.delete(old);
  return hits <= max;
}

// rpc(args) must resolve to { data, error } like the Supabase client. Resolves when allowed; throws HttpError otherwise.
async function checkLimit({ rpc, key, windowSec, max, env = process.env, now = Date.now, memory = devMemory, log = console.error }) {
  let res;
  try { res = await rpc({ p_key: key, p_window_seconds: windowSec, p_max: max }); }
  catch (e) { res = { data: null, error: { code: 'EXCEPTION', message: String((e && e.message) || e) } }; }
  const { data, error } = res || {};

  if (error) {
    if (isMissingFunction(error)) {
      if (isProduction(env)) {
        log('RATE LIMITING UNAVAILABLE: rate_limit_hit() is missing. Apply migration 0003_rate_limits.sql. Refusing the request.');
        throw new HttpError(503, 'This feature is temporarily unavailable. Please try again later.');
      }
      if (devFallback({ key, windowSec, max, now, memory, log })) return;
      throw new HttpError(429, 'You are doing that too often. Please wait a while and try again.');
    }
    log('rate limit check failed:', String(error.code || 'error'));
    throw new HttpError(503, 'Please try again in a moment.');
  }
  if (typeof data !== 'boolean') { log('rate limit check returned an unexpected value'); throw new HttpError(503, 'Please try again in a moment.'); }
  if (!data) throw new HttpError(429, 'You are doing that too often. Please wait a while and try again.');
}

module.exports = { IP_LIMIT, ipKey, LIMITS, checkLimit, isProduction, isMissingFunction, _resetDevFallback: () => { devWarned = false; devMemory.clear(); } };
