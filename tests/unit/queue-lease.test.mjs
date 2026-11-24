// runWithLease: periodic renewal that never overlaps, stops when the job ends, and stops a worker that lost its lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import q from '../../lib/queue.js';

const { runWithLease, LeaseLostError } = q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = { id: 7 };
const opts = (over = {}) => ({ worker: 'w1', leaseSeconds: 60, everyMs: 20, marginMs: 0, ...over });

test('renews the lease on a timer while the handler runs, and returns the handler result', async () => {
  let calls = 0;
  const r = await runWithLease({}, job, async () => { await sleep(130); return 'done'; }, opts({ renew: async () => { calls++; return true; } }));
  assert.equal(r, 'done');
  assert.ok(calls >= 4 && calls <= 7, `renewals: ${calls}`);
});

test('renewal is called with the job, the worker and the lease length', async () => {
  const seen = [];
  await runWithLease('DB', job, async () => { await sleep(50); }, opts({ leaseSeconds: 123, renew: async (...a) => { seen.push(a); return true; } }));
  assert.deepEqual(seen[0], ['DB', job, 'w1', 123]);
});

test('renewals never overlap, even when one is slower than the interval', async () => {
  let running = 0, peak = 0, calls = 0;
  await runWithLease({}, job, async () => { await sleep(250); }, opts({ everyMs: 10, renew: async () => { calls++; running++; peak = Math.max(peak, running); await sleep(60); running--; return true; } }));
  assert.equal(peak, 1, 'at most one renewal in flight');
  assert.ok(calls >= 2 && calls <= 5, `calls: ${calls}`); // spaced by the renewal time, not piled up
});

test('renewal stops after the handler finishes, after it throws, and an in-flight renewal is awaited', async () => {
  let calls = 0;
  const renew = async () => { calls++; await sleep(40); return true; };
  await runWithLease({}, job, async () => { await sleep(25); }, opts({ renew }));
  const afterSuccess = calls;
  await sleep(150);
  assert.equal(calls, afterSuccess, 'no renewal after a successful job');
  await assert.rejects(runWithLease({}, job, async () => { await sleep(25); throw new Error('boom'); }, opts({ renew })), /boom/);
  const afterFailure = calls;
  await sleep(150);
  assert.equal(calls, afterFailure, 'no renewal after a failed job');
});

test('when the database says the lease is gone, the worker is stopped before it can write', async () => {
  const writes = [];
  const err = await runWithLease({}, job, async (lease) => {
    await sleep(80);
    lease.assertHeld(); // the guard every handler calls before a write
    writes.push('should not happen');
  }, opts({ renew: async () => false })).catch((e) => e);
  assert.ok(err instanceof LeaseLostError); assert.equal(err.jobId, 7);
  assert.deepEqual(writes, []);
});

test('a handler that finishes after losing its lease is reported as lost, not as a result', async () => {
  const err = await runWithLease({}, job, async () => { await sleep(80); return 'finished anyway'; }, opts({ renew: async () => false })).catch((e) => e);
  assert.ok(err instanceof LeaseLostError);
});

test('one failed renewal is tolerated, two in a row are not', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n === 2) throw new Error('db hiccup'); return true; };
  assert.equal(await runWithLease({}, job, async () => { await sleep(150); return 'ok'; }, opts({ renew: flaky })), 'ok');
  const err = await runWithLease({}, job, async () => { await sleep(150); }, opts({ renew: async () => { throw new Error('db down'); } })).catch((e) => e);
  assert.ok(err instanceof LeaseLostError);
});

test('a success in between resets the failure count', async () => {
  const pattern = [false, true, false, true, false, true, true, true]; let i = 0;
  const renew = async () => { const ok = pattern[i++ % pattern.length]; if (!ok) throw new Error('x'); return true; };
  assert.equal(await runWithLease({}, job, async () => { await sleep(180); return 'ok'; }, opts({ renew })), 'ok');
});

test('if renewals cannot be confirmed, the worker stops once the lease would have expired on its own', async () => {
  let t = 1_000_000;
  const now = () => t;
  const error = await runWithLease({}, job, async (lease) => {
    lease.assertHeld();            // fine at the start
    t += 59_000; lease.assertHeld(); // still inside the 60 s lease
    t += 2_000;                    // 61 s: past expiry with no successful renewal
    lease.assertHeld();
  }, opts({ now, maxFailures: 1000, renew: async () => { throw new Error('db unreachable'); } })).catch((e) => e);
  assert.ok(error instanceof LeaseLostError);
});

test('a successful renewal pushes the local expiry forward', async () => {
  let t = 5_000_000;
  const now = () => t;
  await runWithLease({}, job, async (lease) => {
    const first = lease.expiresAt;
    t += 30_000; await sleep(60); // a renewal runs and succeeds
    assert.ok(lease.expiresAt > first, 'expiry moved');
    lease.assertHeld();
  }, opts({ now, renew: async () => true }));
});

test('the safety margin makes the worker stop slightly before the database lease ends', async () => {
  let t = 0; const now = () => t;
  const err = await runWithLease({}, job, async (lease) => { t += 56_000; lease.assertHeld(); }, opts({ now, marginMs: 5000, renew: async () => true })).catch((e) => e);
  assert.ok(err instanceof LeaseLostError);
});
