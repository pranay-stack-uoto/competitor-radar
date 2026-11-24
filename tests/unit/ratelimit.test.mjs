import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import rl from '../../lib/security/ratelimit.js';
import v from '../../lib/security/validate.js';

const { checkLimit, LIMITS, isProduction } = rl;
const { HttpError } = v;
let logs;
const log = (...a) => logs.push(a.join(' '));
beforeEach(() => { logs = []; rl._resetDevFallback(); });

const ok = (data = true) => async () => ({ data, error: null });
const err = (error) => async () => ({ data: null, error });
const run = (rpc, env, extra = {}) => checkLimit({ rpc, key: 'verify:u1', windowSec: 3600, max: 3, env, log, ...extra });
const status = (p) => p.then(() => 'allowed', (e) => (e instanceof HttpError ? e.status : 'other:' + e.message));
const MISSING = [{ code: 'PGRST202', message: 'x' }, { code: '42883', message: 'function public.rate_limit_hit(text, integer, integer) does not exist' }, { code: 'X', message: 'Could not find the function public.rate_limit_hit' }];

test('within the limit the request is allowed and the database is asked with the right arguments', async () => {
  let seen; await run(async (a) => { seen = a; return { data: true, error: null }; }, { NODE_ENV: 'production' });
  assert.deepEqual(seen, { p_key: 'verify:u1', p_window_seconds: 3600, p_max: 3 });
});

test('over the limit is a 429 with a friendly message', async () => {
  const e = await run(ok(false), { NODE_ENV: 'production' }).catch((x) => x);
  assert.equal(e.status, 429); assert.match(e.message, /too often/);
});

test('PRODUCTION: a missing rate_limit_hit() is a controlled 503, never a pass, and it is logged loudly', async () => {
  for (const m of MISSING) {
    logs = [];
    assert.equal(await status(run(err(m), { NODE_ENV: 'production' })), 503, JSON.stringify(m));
    assert.match(logs.join(' '), /RATE LIMITING UNAVAILABLE.*0003/);
  }
});
test('fail closed whenever the environment is not explicitly development or test', async () => {
  for (const NODE_ENV of ['production', 'staging', 'preview', '', undefined, 'PRODUCTION', 'dev']) {
    assert.equal(await status(run(err(MISSING[0]), { NODE_ENV })), 503, String(NODE_ENV));
    assert.equal(isProduction({ NODE_ENV }), true, String(NODE_ENV));
  }
  assert.equal(isProduction({}), true);
  assert.equal(isProduction({ NODE_ENV: 'development' }), false); assert.equal(isProduction({ NODE_ENV: 'test' }), false);
});
test('the error shown to the user never reveals the migration or database details', async () => {
  const e = await run(err(MISSING[1]), { NODE_ENV: 'production' }).catch((x) => x);
  assert.doesNotMatch(e.message, /migration|rate_limit|function|0003|postgres/i);
});

test('DEVELOPMENT/TEST: an explicit in-memory fallback applies the same limits and announces itself once', async () => {
  const env = { NODE_ENV: 'test' };
  const res = []; for (let i = 0; i < 5; i++) res.push(await status(run(err(MISSING[0]), env)));
  assert.deepEqual(res, ['allowed', 'allowed', 'allowed', 429, 429]);
  assert.equal(logs.filter((l) => /DEVELOPMENT fallback/.test(l)).length, 1);
  assert.equal(await status(run(err(MISSING[0]), env, { key: 'other:u2' })), 'allowed'); // keys are independent
});
test('the development fallback starts a new window when time moves on', async () => {
  const env = { NODE_ENV: 'development' }; let t = 0;
  const call = () => status(run(err(MISSING[0]), env, { now: () => t }));
  assert.deepEqual([await call(), await call(), await call(), await call()], ['allowed', 'allowed', 'allowed', 429]);
  t += 3600 * 1000;
  assert.equal(await call(), 'allowed');
});

test('other database errors are a 503 in EVERY environment, including development (no fallback)', async () => {
  for (const NODE_ENV of ['production', 'development', 'test'])
    for (const e of [{ code: '57014', message: 'canceling statement due to statement timeout' }, { code: '08006', message: 'connection failure' }, { code: '42501', message: 'permission denied for function rate_limit_hit' }, { code: 'PGRST301', message: 'JWT expired' }])
      assert.equal(await status(run(err(e), { NODE_ENV })), 503, `${NODE_ENV} ${e.code}`);
});
test('a thrown exception (network failure) is a 503, not an unhandled error and not a pass', async () => {
  for (const NODE_ENV of ['production', 'test']) assert.equal(await status(run(async () => { throw new Error('fetch failed'); }, { NODE_ENV })), 503);
});
test('an unexpected answer is a 503, never treated as allowed', async () => {
  for (const data of [null, undefined, 'true', 1, {}, []]) assert.equal(await status(run(async () => ({ data, error: null }), { NODE_ENV: 'production' })), 503, String(data));
  assert.equal(await status(run(async () => undefined, { NODE_ENV: 'production' })), 503);
});

test('the per-user limits are exactly the documented ones and cannot be changed at runtime', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LIMITS)), {
    extract: { max: 6, windowSec: 3600 }, verify: { max: 30, windowSec: 3600 }, insights: { max: 6, windowSec: 3600 },
    competitorAdd: { max: 30, windowSec: 86400 }, nudge: { max: 240, windowSec: 3600 }, projectStart: { max: 20, windowSec: 86400 }, gsc: { max: 20, windowSec: 3600 },
  });
  assert.throws(() => { 'use strict'; LIMITS.verify = { max: 9999, windowSec: 1 }; });
});

test('lib/http.js delegates to checkLimit and contains no fail-open branch', () => {
  const code = readFileSync(new URL('../../lib/http.js', import.meta.url), 'utf8');
  assert.match(code, /checkLimit\(/);
  assert.doesNotMatch(code, /rate limiting is OFF|carry on|return;\s*\}/);
});
