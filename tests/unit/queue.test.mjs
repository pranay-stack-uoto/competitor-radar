import { test } from 'node:test';
import assert from 'node:assert/strict';
import q from '../../lib/queue.js';
import guard from '../../lib/security/netguard.js';

const { classifyError, scrub, enqueue, claim, complete, fail } = q;
const err = (props, message = 'boom') => Object.assign(new Error(message), props);

test('guard errors that can never succeed are permanent; transient ones are retryable', () => {
  for (const code of ['blocked-address', 'blocked-host', 'ip-literal', 'bad-protocol', 'bad-url', 'bad-port', 'credentials', 'too-large'])
    assert.equal(classifyError(new guard.GuardError(code)).permanent, true, code);
  for (const code of ['timeout', 'dns-failed', 'too-many-redirects']) assert.equal(classifyError(new guard.GuardError(code)).permanent, false, code);
});
test('HTTP statuses: 5xx, 429 and timeouts retry; other 4xx are permanent', () => {
  for (const status of [500, 502, 503, 429, 408]) assert.equal(classifyError(err({ status })).permanent, false, String(status));
  for (const status of [400, 401, 403, 404, 422]) assert.equal(classifyError(err({ status })).permanent, true, String(status));
});
test('database constraint and syntax errors are permanent; network errors retry; unknown errors retry (bounded by max_attempts)', () => {
  for (const code of ['23505', '23514', '22P02', '42703', '42P01']) assert.equal(classifyError(err({ code })).permanent, true, code);
  for (const m of ['fetch failed', 'ECONNRESET', 'socket hang up']) assert.equal(classifyError(err({}, m)).permanent, false, m);
  assert.equal(classifyError(err({}, 'something odd')).permanent, false);
  assert.equal(classifyError('a string').permanent, false);
  assert.equal(classifyError(null).permanent, false);
});
test('an error can mark itself permanent', () => {
  assert.equal(classifyError(err({ permanent: true, code: 'no-project' })).permanent, true);
});
test('stored error messages never contain anything that looks like a credential, and are capped', () => {
  const secret = 'sb_secret_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  const m = classifyError(err({}, `request failed for key ${secret} at https://x?token=${'z'.repeat(60)}`)).message;
  assert.doesNotMatch(m, /sb_secret_A1b2|zzzzzzzz/);
  assert.ok(scrub('x '.repeat(1000)).length <= 400);
});

// The wrapper only talks to the database through rpc(); verify what it sends.
const fakeDb = (impl) => ({ calls: [], rpc(fn, args) { this.calls.push([fn, args]); return Promise.resolve(impl(fn, args)); } });
test('enqueue and claim call the database functions with the right arguments', async () => {
  const db = fakeDb((fn) => ({ data: fn === 'claim_job' ? [{ id: 7, kind: 'crawl', lease_token: 'tok-7' }] : 42, error: null }));
  assert.equal(await enqueue(db, { projectId: 'p', day: '2026-11-05', kind: 'crawl', domain: 'a.example.com' }), 42);
  assert.deepEqual(db.calls[0][1], { p_project: 'p', p_day: '2026-11-05', p_kind: 'crawl', p_domain: 'a.example.com', p_run_after: db.calls[0][1].p_run_after, p_max_attempts: 3 });
  assert.equal((await claim(db, 'w1')).id, 7);
  assert.deepEqual(db.calls[1], ['claim_job', { p_worker: 'w1', p_lease_seconds: 300 }]);
});
test('a claim without a lease token is an error (migration 0010 missing), not a job nobody can finish', async () => {
  await assert.rejects(claim(fakeDb(() => ({ data: [{ id: 9, kind: 'crawl' }], error: null }))), /apply migration 0010/);
});
test('claim returns null when the queue is empty', async () => {
  assert.equal(await claim(fakeDb(() => ({ data: [], error: null }))), null);
});
test('fail passes the classification to the database', async () => {
  const db = fakeDb(() => ({ data: 'queued', error: null }));
  await fail(db, { id: 5, lease_token: 'tok-5' }, new guard.GuardError('blocked-address'), 'w1');
  assert.equal(db.calls[0][0], 'fail_job');
  assert.equal(db.calls[0][1].p_permanent, true);
  assert.match(db.calls[0][1].p_error, /^\[blocked-address\]/);
  await fail(db, { id: 5, lease_token: 'tok-5' }, err({ status: 503 }), 'w1');
  assert.equal(db.calls[1][1].p_permanent, false);
  await complete(db, { id: 5, lease_token: 'tok-5' }, 'w1');
  assert.deepEqual(db.calls[2], ['complete_job', { p_id: 5, p_worker: 'w1', p_token: 'tok-5' }]);
  assert.equal(db.calls[0][1].p_token, 'tok-5');
});
test('database errors surface as exceptions with a short message', async () => {
  const db = fakeDb(() => ({ data: null, error: { message: 'permission denied for function claim_job', code: '42501' } }));
  await assert.rejects(claim(db), /claim_job: permission denied/);
});
