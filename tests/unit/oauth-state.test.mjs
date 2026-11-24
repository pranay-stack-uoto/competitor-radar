// The application side of single-use OAuth state: signature + expiry + a server-side nonce, with the database faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { startOAuth, finishOAuth, hashNonce } = require('../../lib/security/oauthState.js');
const { signState, readState } = require('../../lib/security/crypto.js');

const ENV = { NODE_ENV: 'production', TOKEN_ENC_KEYS: JSON.stringify({ 1: crypto.randomBytes(32).toString('base64') }) };
const U = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// A tiny in-memory stand-in for the two SQL functions, with the same rules (one use, bound to user and project, burned on first presentation).
function fakeDb() {
  const rows = new Map(); const calls = [];
  return { calls, rows, async rpc(fn, a) {
    calls.push([fn, a]);
    if (fn === 'oauth_state_create') { rows.set(a.p_hash, { user: a.p_user, project: a.p_project, used: false }); return { data: true, error: null }; }
    if (fn === 'oauth_state_consume') { const r = rows.get(a.p_hash); if (!r || r.used) return { data: false, error: null }; r.used = true; return { data: r.user === a.p_user && r.project === a.p_project, error: null }; }
    return { data: null, error: { message: 'unknown' } };
  } };
}

test('a state carries a random nonce, only its hash is stored, and it is bound to the user and project', async () => {
  const db = fakeDb();
  const state = await startOAuth(db, { userId: U, projectId: P }, ENV);
  const payload = readState(state, ENV);
  assert.equal(payload.userId, U); assert.equal(payload.projectId, P);
  assert.match(payload.n, /^[A-Za-z0-9_-]{43}$/);
  const [fn, args] = db.calls[0];
  assert.equal(fn, 'oauth_state_create'); assert.equal(args.p_hash, hashNonce(payload.n));
  assert.ok(!JSON.stringify(args).includes(payload.n), 'the raw nonce is never sent to storage');
  assert.deepEqual([args.p_user, args.p_project, args.p_ttl_seconds], [U, P, 600]);
  const other = readState(await startOAuth(fakeDb(), { userId: U, projectId: P }, ENV), ENV);
  assert.notEqual(other.n, payload.n, 'every state has its own nonce');
});
test('VALID USE: the callback accepts a fresh state once and returns who started it', async () => {
  const db = fakeDb(); const state = await startOAuth(db, { userId: U, projectId: P }, ENV);
  assert.deepEqual(await finishOAuth(db, state, ENV), { ok: true, userId: U, projectId: P });
});
test('REPLAY: the same state a second time is refused', async () => {
  const db = fakeDb(); const state = await startOAuth(db, { userId: U, projectId: P }, ENV);
  assert.equal((await finishOAuth(db, state, ENV)).ok, true);
  const again = await finishOAuth(db, state, ENV);
  assert.equal(again.ok, false); assert.equal(again.reason, 'used-or-invalid');
});
test('EXPIRY: a state past its signed expiry is refused without touching the database', async () => {
  const db = fakeDb(); const state = await startOAuth(db, { userId: U, projectId: P }, ENV); db.calls.length = 0;
  const later = Date.now() + 16 * 60 * 1000;
  assert.deepEqual(await finishOAuth(db, state, ENV, later), { ok: false, reason: 'bad-state' });
  assert.equal(db.calls.length, 0);
});
test('MISMATCH: a state forged for another user or project, or with a swapped payload, is refused', async () => {
  const db = fakeDb(); const real = readState(await startOAuth(db, { userId: U, projectId: P }, ENV), ENV);
  // An attacker who can sign nothing cannot change the payload: tampering breaks the signature.
  const [body, sig] = (await startOAuth(fakeDb(), { userId: U, projectId: P }, ENV)).split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), userId: U2 })).toString('base64url') + '.' + sig;
  assert.equal((await finishOAuth(db, tampered, ENV)).ok, false);
  // Even a correctly signed state whose nonce belongs to someone else is refused by the database binding (and burns the nonce).
  const foreign = signState({ projectId: P2, userId: U2, n: real.n }, ENV);
  assert.equal((await finishOAuth(db, foreign, ENV)).reason, 'used-or-invalid');
  const legit = signState({ projectId: P, userId: U, n: real.n }, ENV);
  assert.equal((await finishOAuth(db, legit, ENV)).ok, false, 'the nonce was burned by the wrong presentation');
});
test('CONCURRENT: many callbacks with one state at the same moment: exactly one succeeds', async () => {
  const db = fakeDb(); const state = await startOAuth(db, { userId: U, projectId: P }, ENV);
  const results = await Promise.all(Array.from({ length: 25 }, () => finishOAuth(db, state, ENV)));
  assert.equal(results.filter((r) => r.ok).length, 1);
});
test('old-style states without a nonce, with a malformed nonce or with bad ids are refused', async () => {
  const db = fakeDb();
  for (const payload of [{ projectId: P, userId: U }, { projectId: P, userId: U, n: 'short' }, { projectId: P, userId: U, n: 5 }, { projectId: 'x', userId: U, n: 'a'.repeat(43) }, { projectId: P, userId: 'x', n: 'a'.repeat(43) }]) {
    assert.equal((await finishOAuth(db, signState(payload, ENV), ENV)).reason, 'bad-state', JSON.stringify(payload));
  }
  for (const junk of [null, undefined, '', 'a.b', 'x']) assert.equal((await finishOAuth(db, junk, ENV)).ok, false);
  assert.equal(db.calls.length, 0, 'nothing reached the database');
});
test('a state signed with a different key is refused', async () => {
  const db = fakeDb(); const other = { ...ENV, TOKEN_ENC_KEYS: JSON.stringify({ 1: crypto.randomBytes(32).toString('base64') }) };
  assert.equal((await finishOAuth(db, await startOAuth(fakeDb(), { userId: U, projectId: P }, other), ENV)).ok, false);
});
test('if the database is unavailable the flow fails closed in both directions', async () => {
  const broken = { rpc: async () => ({ data: null, error: { message: 'down' } }) };
  await assert.rejects(startOAuth(broken, { userId: U, projectId: P }, ENV), (e) => e.status === 503 && !/down/.test(e.message));
  const thrower = { rpc: async () => { throw new Error('network'); } };
  await assert.rejects(startOAuth(thrower, { userId: U, projectId: P }, ENV), (e) => e.status === 503);
  const state = await startOAuth(fakeDb(), { userId: U, projectId: P }, ENV);
  assert.equal((await finishOAuth(broken, state, ENV)).reason, 'unavailable');
  assert.equal((await finishOAuth(thrower, state, ENV)).reason, 'unavailable');
  const denied = { rpc: async () => ({ data: false, error: null }) };
  await assert.rejects(startOAuth(denied, { userId: U, projectId: P }, ENV), (e) => e.status === 403);
});
test('in production the state cannot be signed with the legacy service-role key (item 3 applies here too)', async () => {
  await assert.rejects(startOAuth(fakeDb(), { userId: U, projectId: P }, { NODE_ENV: 'production', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40) }), /required in production/);
});
test('the routes use the single-use flow: connect starts it, the callback consumes it before doing anything else, and nothing verifies a bare signed state any more', () => {
  const r = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
  const connect = r('app/api/gsc/connect/route.js'), cb = r('app/api/gsc/callback/route.js');
  assert.match(connect, /startOAuth\(/); assert.doesNotMatch(connect, /signState\(/);
  assert.match(cb, /finishOAuth\(/); assert.doesNotMatch(cb, /readState\(/);
  assert.ok(cb.indexOf('finishOAuth(') < cb.indexOf('exchangeCode(') && cb.indexOf('finishOAuth(') < cb.indexOf("from('projects')"));
  assert.match(cb, /project_role_for/, 'the admin recheck stays');
});
