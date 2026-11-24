// runWithLease: the abort signal, fenced writes and the outcome of a finished job (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const q = require('../../lib/queue.js');
const { createGuard, createByteBudget, GuardError } = require('../../lib/security/netguard.js');
const { crawlSite } = require('../../lib/crawl.js');

const JOB = { id: 7, kind: 'crawl', lease_token: 'tok-7' };
// A fake database: `answers` maps a function name to what it returns (a value, or a function of the arguments).
const fakeDb = (answers = {}) => {
  const calls = [];
  return { calls, async rpc(fn, args) {
    calls.push([fn, args]);
    const a = answers[fn];
    const data = typeof a === 'function' ? a(args) : a;
    if (data instanceof Error) return { data: null, error: { message: data.message, code: data.code } };
    return { data: data === undefined ? true : data, error: null };
  } };
};
const names = (db) => db.calls.map((c) => c[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (extra = {}) => ({ worker: 'w', leaseSeconds: 60, everyMs: 20, marginMs: 0, ...extra });

// ---------------- lease.write ----------------
test('lease.write sends the job id, worker and token with every fenced call, and returns the database answer', async () => {
  const db = fakeDb({ job_write_score: true });
  const out = await q.runWithLease(db, JOB, (lease) => lease.write('job_write_score', { p_seo: 1 }), { ...opts(), renew: async () => true });
  assert.equal(out, true);
  assert.deepEqual(db.calls[0], ['job_write_score', { p_id: 7, p_worker: 'w', p_token: 'tok-7', p_seo: 1 }]);
});
test('when the database refuses a fenced write the lease is lost, the signal aborts and a LeaseLostError is thrown', async () => {
  for (const answer of [false, null]) {
    const db = fakeDb({ job_write_score: answer });
    let signal;
    const err = await q.runWithLease(db, JOB, async (lease) => { signal = lease.signal; await lease.write('job_write_score', {}); }, { ...opts(), renew: async () => true }).catch((e) => e);
    assert.ok(err instanceof q.LeaseLostError, String(answer));
    assert.equal(signal.aborted, true);
  }
});
test('a count of zero from a fenced call is a success, not a lost lease', async () => {
  const db = fakeDb({ job_enqueue_crawls: 0 });
  assert.equal(await q.runWithLease(db, JOB, (lease) => lease.write('job_enqueue_crawls', { p_domains: [] }), { ...opts(), renew: async () => true }), 0);
});
test('after the lease is lost no further fenced write is even sent', async () => {
  const db = fakeDb({ job_write_score: false });
  await q.runWithLease(db, JOB, async (lease) => {
    await lease.write('job_write_score', {}).catch(() => {});
    await assert.rejects(lease.write('job_write_audit', {}), q.LeaseLostError);
  }, { ...opts(), renew: async () => true }).catch(() => {});
  assert.deepEqual(names(db), ['job_write_score']);
});

// ---------------- the abort signal ----------------
test('the signal aborts as soon as a renewal is refused', async () => {
  const db = fakeDb();
  let aborted = false;
  const err = await q.runWithLease(db, JOB, async (lease) => { lease.signal.addEventListener('abort', () => { aborted = true; }); await sleep(300); lease.assertHeld(); }, { ...opts(), renew: async () => false }).catch((e) => e);
  assert.equal(aborted, true); assert.ok(err instanceof q.LeaseLostError);
});
test('the signal aborts when renewals keep failing, and when the lease runs out with no renewal', async () => {
  let t0 = Date.now(), at;
  await q.runWithLease(fakeDb(), JOB, async (lease) => { lease.signal.addEventListener('abort', () => { at = Date.now() - t0; }); await sleep(200); }, { ...opts(), renew: async () => { throw new Error('db down'); } }).catch(() => {});
  assert.ok(at !== undefined && at < 150, `aborted after ${at} ms`);
  t0 = Date.now(); at = undefined;
  await q.runWithLease(fakeDb(), JOB, async (lease) => { lease.signal.addEventListener('abort', () => { at = Date.now() - t0; }); await sleep(1500); }, { ...opts({ leaseSeconds: 1, everyMs: 100000 }), renew: async () => true }).catch(() => {});
  assert.ok(at >= 900 && at < 1300, `aborted at ${at} ms (the lease was 1 s and never renewed)`);
});
test('the signal is not aborted while the lease is being renewed, and is aborted once the handler returns', async () => {
  let signal, during;
  await q.runWithLease(fakeDb(), JOB, async (lease) => { signal = lease.signal; await sleep(120); during = signal.aborted; }, { ...opts(), renew: async () => true });
  assert.equal(during, false); assert.equal(signal.aborted, true);
});
test('a supported in-flight HTTP call is aborted when the lease is lost', async () => {
  const server = http.createServer(() => {}); // never answers
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const t0 = Date.now();
    const err = await q.runWithLease(fakeDb(), JOB, async (lease) => { await fetch(url, { signal: lease.signal }); }, { ...opts({ everyMs: 80 }), renew: async () => false }).catch((e) => e);
    assert.ok(err instanceof q.LeaseLostError, `${err && err.name}: an abort caused by the lost lease is reported as a lost lease, not as a job failure`);
    assert.ok(Date.now() - t0 < 1500);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});
test('the SSRF-guarded request is aborted by a signal, directly or through the crawl byte budget', async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost.test:${server.address().port}/`;
  const guard = createGuard({ lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]), isBlocked: () => false, anyPort: true });
  try {
    for (const via of ['option', 'budget']) {
      const ctrl = new AbortController();
      const args = via === 'option' ? { signal: ctrl.signal, timeoutMs: 10000 } : { budget: createByteBudget(1e6, { signal: ctrl.signal }), timeoutMs: 10000 };
      const pending = guard.request(url, args).catch((e) => e);
      await sleep(50); ctrl.abort();
      const err = await pending;
      assert.ok(err instanceof GuardError && err.code === 'aborted', `${via}: ${err && err.code}`);
    }
    const done = new AbortController(); done.abort();
    await assert.rejects(guard.request(url, { signal: done.signal }), (e) => e.code === 'aborted', 'already aborted: nothing is sent');
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});
test('a crawl given an aborted signal stops at once and throws instead of returning a partial crawl', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  const err = await crawlSite('https://example.com', { crawl: { maxPagesPerSite: 5, delayMs: 0, maxMs: 5000, userAgent: 'test' }, keywords: [], locations: [], signal: ctrl.signal }).catch((e) => e);
  assert.ok(err instanceof GuardError && err.code === 'aborted', String(err && err.code));
});

// ---------------- what happens when a job ends ----------------
const quiet = () => {};
test('a normal run completes the job with its token', async () => {
  const db = fakeDb({ complete_job: true });
  assert.equal(await q.runClaimedJob(db, JOB, async () => {}, { ...opts(), renew: async () => true }, quiet), 'done');
  assert.deepEqual(db.calls.at(-1), ['complete_job', { p_id: 7, p_worker: 'w', p_token: 'tok-7' }]);
});
test('complete_job returning false is lost ownership: not reported as done, the job is not failed, and the log is concise and safe', async () => {
  const db = fakeDb({ complete_job: false });
  const logs = [];
  const out = await q.runClaimedJob(db, { ...JOB, secret: 'x'.repeat(40) }, async () => {}, { ...opts(), renew: async () => true }, (...a) => logs.push(a.join(' ')));
  assert.equal(out, 'completion-rejected');
  assert.ok(!names(db).includes('fail_job'), 'never fail a job with a stale token');
  assert.equal(logs.length, 1); assert.match(logs[0], /completion rejected/); assert.doesNotMatch(logs[0], /tok-7|xxxx/);
});
test('an error while completing leaves the job to lease expiry and does not fail it', async () => {
  const db = fakeDb({ complete_job: new Error('connection reset') });
  assert.equal(await q.runClaimedJob(db, JOB, async () => {}, { ...opts(), renew: async () => true }, quiet), 'completion-unknown');
  assert.ok(!names(db).includes('fail_job'));
});
test('a handler that lost the job neither completes nor fails it, even when the abort made it throw something else', async () => {
  for (const make of [
    async (lease) => { await lease.write('job_write_score', {}); },                                  // refused write
    async (lease) => { await sleep(100); throw new GuardError('aborted'); },                           // renewal refused -> abort -> the fetch throws
  ]) {
    const db = fakeDb({ job_write_score: false });
    const out = await q.runClaimedJob(db, JOB, make, { ...opts(), renew: async (d, j, w, s) => { await sleep(10); return false; } }, quiet);
    assert.equal(out, 'lost');
    assert.ok(!names(db).includes('complete_job') && !names(db).includes('fail_job'), names(db).join());
  }
});
test('a genuine handler error still fails the job (with the token) so it is retried', async () => {
  const db = fakeDb({ fail_job: 'queued' });
  const out = await q.runClaimedJob(db, JOB, async () => { throw Object.assign(new Error('boom'), { status: 503 }); }, { ...opts(), renew: async () => true }, quiet);
  assert.equal(out, 'failed');
  const f = db.calls.find((c) => c[0] === 'fail_job');
  assert.equal(f[1].p_token, 'tok-7'); assert.equal(f[1].p_permanent, false);
  assert.ok(!names(db).includes('complete_job'));
});
test('a handler that finishes after the lease ran out is not completed', async () => {
  const db = fakeDb();
  const out = await q.runClaimedJob(db, JOB, async () => { await sleep(1200); }, { ...opts({ leaseSeconds: 1, everyMs: 100000 }), renew: async () => true }, quiet);
  assert.equal(out, 'lost');
  assert.ok(!names(db).includes('complete_job'));
});
