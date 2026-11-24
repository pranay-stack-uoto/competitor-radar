// Calls from the app to itself (kicking the background worker) carry CRON_SECRET, so WHERE they go must never depend on anything a
// client can influence. The destination is built only from the configured APP_URL and a fixed path; the request that triggered the call
// (its URL, Host and X-Forwarded-* headers) is never consulted. In production a missing or malformed APP_URL means the call is not made.
const { isValidHostname } = require('./netguard');

const isProduction = (env) => !['development', 'test'].includes(String(env.NODE_ENV || ''));
const ALLOWED_PATHS = new Set(['/api/cron/work']);

// The exact origin of this deployment, e.g. "https://app.example.com". Throws a plain Error (never echoing the value) when it cannot be trusted.
function appOrigin(env = process.env) {
  const raw = String(env.APP_URL || '').trim();
  if (!raw) {
    if (isProduction(env)) throw new Error('APP_URL is not set');
    return `http://localhost:${env.PORT || 4020}`; // development and tests only; never derived from a request
  }
  let u;
  try { u = new URL(raw); } catch { throw new Error('APP_URL is not a valid URL'); }
  if (u.username || u.password) throw new Error('APP_URL must not contain credentials');
  if (u.search || u.hash || !(u.pathname === '/' || u.pathname === '')) throw new Error('APP_URL must be an origin only (no path, query or fragment)');
  if (isProduction(env)) {
    if (u.protocol !== 'https:') throw new Error('APP_URL must use https in production');
    if (u.port) throw new Error('APP_URL must not set a port in production');
    if (!isValidHostname(u.hostname)) throw new Error('APP_URL must be a public host name');
  } else if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('APP_URL must be http or https');
  return u.origin;
}

// A URL on this deployment for one of the allowed internal paths. The parameter list is deliberately only the path: there is no way to pass a request.
function internalUrl(path, env = process.env) {
  if (!ALLOWED_PATHS.has(path)) throw new Error('Not an allowed internal path');
  const origin = appOrigin(env);
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== path || url.search || url.hash) throw new Error('Internal URL check failed'); // belt and braces
  return url;
}

// Starts the worker. Returns { sent, reason, done } and never throws, so a misconfiguration cannot break the user's request.
// `done` settles once the request has been answered (the worker route answers at once and works in the background). On Vercel a request
// that is not awaited is cut off when the calling function returns, so callers MUST `await kickWorker().done`.
// The secret goes only to the validated URL; redirects are NOT followed (a redirect response is treated as a failure), so the credential
// cannot be carried to another origin.
function kickWorker({ env = process.env, fetchFn = globalThis.fetch, log = console.error } = {}) {
  let url;
  try { url = internalUrl('/api/cron/work', env); }
  catch (e) { log('worker kick skipped:', e.message); return { sent: false, reason: 'bad-app-url', done: Promise.resolve() }; }
  if (!env.CRON_SECRET) { log('worker kick skipped: CRON_SECRET is not set'); return { sent: false, reason: 'no-secret', done: Promise.resolve() }; }
  const done = Promise.resolve()
    .then(() => fetchFn(url.href, { method: 'GET', headers: { authorization: `Bearer ${env.CRON_SECRET}` }, redirect: 'manual', signal: AbortSignal.timeout(30000) }))
    .then((res) => { if (res && res.status >= 300 && res.status < 400) log('worker kick got a redirect and did not follow it'); })
    .catch(() => {});
  return { sent: true, url: url.href, done };
}

module.exports = { appOrigin, internalUrl, kickWorker, isProduction };
