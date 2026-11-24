// Self-calls carry CRON_SECRET: the destination must come only from a valid, fixed APP_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { appOrigin, internalUrl, kickWorker } = createRequire(import.meta.url)('../../lib/security/selfcall.js');

const PROD = { NODE_ENV: 'production', APP_URL: 'https://radar.example.com', CRON_SECRET: 'cron-secret-value-123' };
const quiet = () => {};

test('production accepts a plain https origin (a trailing slash and upper case are normalised)', () => {
  assert.equal(appOrigin(PROD), 'https://radar.example.com');
  assert.equal(appOrigin({ ...PROD, APP_URL: 'https://Radar.Example.com/' }), 'https://radar.example.com');
  assert.equal(appOrigin({ ...PROD, NODE_ENV: undefined }), 'https://radar.example.com', 'an unset NODE_ENV is treated as production');
});
test('production fails closed when APP_URL is missing or malformed', () => {
  for (const bad of [undefined, '', '   ', 'not a url', 'radar.example.com', 'http://radar.example.com', 'ftp://radar.example.com', 'https://user:pass@radar.example.com',
    'https://radar.example.com/app', 'https://radar.example.com/?x=1', 'https://radar.example.com/#x', 'https://radar.example.com:8443', 'https://127.0.0.1', 'https://[::1]',
    'https://localhost', 'https://intranet.local', 'https://2130706433', 'javascript:alert(1)', 'https://']) {
    assert.throws(() => appOrigin({ ...PROD, APP_URL: bad }), Error, JSON.stringify(bad));
  }
  assert.throws(() => appOrigin({ NODE_ENV: 'production' }), /APP_URL is not set/);
});
test('error messages never echo the configured value', () => {
  for (const bad of ['https://user:topsecret@radar.example.com', 'http://radar.example.com/secret-path']) {
    try { appOrigin({ ...PROD, APP_URL: bad }); assert.fail('should throw'); } catch (e) { assert.doesNotMatch(e.message, /topsecret|secret-path|radar\.example/); }
  }
});
test('development and tests may use localhost, never anything taken from a request', () => {
  assert.equal(appOrigin({ NODE_ENV: 'development' }), 'http://localhost:4020');
  assert.equal(appOrigin({ NODE_ENV: 'test', PORT: '3000' }), 'http://localhost:3000');
  assert.equal(appOrigin({ NODE_ENV: 'development', APP_URL: 'http://localhost:4020' }), 'http://localhost:4020');
  assert.throws(() => appOrigin({ NODE_ENV: 'development', APP_URL: 'gopher://x' }));
});

test('internalUrl allows only the worker path on the configured origin', () => {
  assert.equal(internalUrl('/api/cron/work', PROD).href, 'https://radar.example.com/api/cron/work');
  for (const bad of ['/api/cron/start', '/api/competitor/add', '//evil.example.com/api/cron/work', 'https://evil.example.com/api/cron/work', '/api/cron/work?x=1', '/api/cron/work/', '', '/\\evil.example.com', 'api/cron/work']) {
    assert.throws(() => internalUrl(bad, PROD), /allowed internal path/, bad);
  }
});
test('the destination cannot be steered by Host or X-Forwarded-Host: the function takes no request at all', () => {
  assert.equal(internalUrl.length <= 2, true);
  const hostile = new Request('https://evil.example.net/api/project/start', { headers: { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'http', origin: 'https://evil.example.net' } });
  const calls = [];
  const out = kickWorker({ env: PROD, fetchFn: async (url, init) => { calls.push([url, init]); return { status: 200 }; }, log: quiet, request: hostile });
  assert.equal(out.sent, true);
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://radar.example.com/api/cron/work');
    assert.ok(!calls[0][0].includes('evil'));
  });
});
test('the secret goes only to the configured origin, as a bearer header, with redirects disabled', async () => {
  const calls = [];
  kickWorker({ env: PROD, fetchFn: async (url, init) => { calls.push([url, init]); return { status: 200 }; }, log: quiet });
  await new Promise((r) => setImmediate(r));
  const [url, init] = calls[0];
  assert.equal(new URL(url).origin, 'https://radar.example.com');
  assert.equal(init.headers.authorization, 'Bearer cron-secret-value-123');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal);
  assert.equal(JSON.stringify(init).includes('evil'), false);
});
test('with a bad or missing APP_URL nothing is sent and the secret is not used', async () => {
  for (const env of [{ ...PROD, APP_URL: undefined }, { ...PROD, APP_URL: 'http://radar.example.com' }, { ...PROD, APP_URL: 'https://radar.example.com/x' }, { ...PROD, APP_URL: 'https://evil.example.net:444' }]) {
    let called = false; const logs = [];
    const out = kickWorker({ env, fetchFn: async () => { called = true; return { status: 200 }; }, log: (...a) => logs.push(a.join(' ')) });
    await new Promise((r) => setImmediate(r));
    assert.equal(out.sent, false); assert.equal(called, false);
    assert.ok(logs.every((l) => !l.includes('cron-secret-value-123')));
  }
});
test('without CRON_SECRET nothing is sent', async () => {
  let called = false;
  const out = kickWorker({ env: { ...PROD, CRON_SECRET: undefined }, fetchFn: async () => { called = true; }, log: quiet });
  assert.equal(out.reason, 'no-secret'); assert.equal(called, false);
});
test('a redirect answer is not followed: exactly one request is made, to the configured origin', async () => {
  const calls = []; const logs = [];
  kickWorker({ env: PROD, fetchFn: async (url, init) => { calls.push(url); return { status: 307, headers: new Headers({ location: 'https://evil.example.net/steal' }) }; }, log: (...a) => logs.push(a.join(' ')) });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['https://radar.example.com/api/cron/work']);
  assert.ok(logs.some((l) => /redirect/.test(l)));
});
test('a failing request never throws into the caller', async () => {
  const out = kickWorker({ env: PROD, fetchFn: async () => { throw new Error('network down'); }, log: quiet });
  assert.equal(out.sent, true);
  await new Promise((r) => setImmediate(r));
});

test('kickWorker exposes `done`, which settles after the request was answered, and callers await it (an un-awaited request is lost on Vercel)', async () => {
  let answered = false;
  const out = kickWorker({ env: PROD, fetchFn: async () => { await new Promise((r) => setTimeout(r, 20)); answered = true; return { status: 200 }; }, log: quiet });
  await out.done;
  assert.equal(answered, true);
  await kickWorker({ env: { ...PROD, APP_URL: undefined }, log: quiet }).done; // never rejects
  for (const f of ['app/api/cron/start/route.js', 'app/api/cron/work/route.js', 'app/api/project/start/route.js', 'app/api/competitor/add/route.js']) {
    assert.match(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), /await kickWorker\(\)\.done/, `${f} must await the kick`);
  }
});

// ---------------- the whole codebase ----------------
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sources = ['app', 'lib'].flatMap((d) => walk(new URL('../../' + d, import.meta.url).pathname)).filter((f) => /\.(js|mjs|jsx)$/.test(f));
test('no source file builds a destination from the request or forwarded headers', () => {
  for (const f of sources) {
    const code = readFileSync(f, 'utf8');
    assert.doesNotMatch(code, /x-forwarded-(host|proto|server)|headers\.get\(['"]host['"]\)/i, `${f} must not read Host or X-Forwarded-* headers`);
    assert.doesNotMatch(code, /new URL\([^)]*req\.url[^)]*\)\.origin/, `${f} must not derive an origin from the request URL`);
    assert.doesNotMatch(code, /internalUrl\([^)]*req/, `${f} must not pass a request to internalUrl`);
  }
});
test('every outbound call that carries CRON_SECRET goes through kickWorker', () => {
  for (const f of sources) {
    if (f.endsWith('selfcall.js')) continue;
    const code = readFileSync(f, 'utf8');
    assert.doesNotMatch(code, /Bearer \$\{process\.env\.CRON_SECRET\}/, `${f} must not send CRON_SECRET itself`);
    assert.doesNotMatch(code, /fetch\([^)]*internalUrl/, `${f} must use kickWorker`);
  }
});
