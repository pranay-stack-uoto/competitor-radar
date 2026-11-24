// renew_job_lease in SQL, and runWithLease against the real queue functions (token based).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser, asSupabase, seedTwoTenants, U1 } from '../helpers/db.mjs';
import q from '../../lib/queue.js';

let db, sb, p1;
before(async () => { db = await createDb(); sb = asSupabase(db); ({ p1 } = await seedTwoTenants(db)); });
beforeEach(async () => { await db.exec('delete from public.jobs'); });

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const enqueue = async (domain = 'a.example.com') => (await rows(`select public.enqueue_job($1, current_date, 'crawl', $2) as id`, [p1, domain]))[0].id;
const claim = async (w = 'w1', lease = 300) => (await rows('select * from public.claim_job($1, $2)', [w, lease]))[0] || null;
const renew = async (j, w = j.locked_by, token = j.lease_token, secs = 300) => (await rows('select public.renew_job_lease($1, $2, $3, $4) as ok', [j.id, w, token, secs]))[0].ok;
const job = async (id) => (await rows('select * from public.jobs where id = $1', [id]))[0];
const leaseLeft = async (id) => Number((await rows('select extract(epoch from lease_expires_at - now()) as s from public.jobs where id = $1', [id]))[0].s);
const expire = (id) => db.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [id]);

test('the owner extends a live lease', async () => {
  const id = await enqueue(); const j = await claim('w1', 60);
  await db.query(`update public.jobs set lease_expires_at = now() + interval '10 seconds' where id = $1`, [id]);
  assert.equal(await renew(j), true);
  assert.ok(await leaseLeft(id) > 290); assert.equal((await job(id)).status, 'running');
});
test('a different worker, no token, a wrong token or a made-up job cannot renew', async () => {
  const id = await enqueue(); const j = await claim('w1', 60); const before = await leaseLeft(id);
  assert.equal(await renew(j, 'w2'), false);
  assert.equal(await renew(j, 'w1', null), false);
  assert.equal(await renew(j, 'w1', '00000000-0000-4000-8000-000000000000'), false);
  assert.equal(await renew({ id: 999999, locked_by: 'w1', lease_token: j.lease_token }), false);
  assert.ok(Math.abs((await leaseLeft(id)) - before) < 3, 'a refused renewal changes nothing');
});
test('a lease that has already expired cannot be renewed, even by the holder of the right token', async () => {
  const id = await enqueue(); const j = await claim('w1', 60); await expire(id);
  assert.equal(await renew(j), false);
});
test('a worker whose job was recovered and claimed again cannot renew, even under the same worker name; the new holder can', async () => {
  const id = await enqueue(); const slow = await claim('same-name', 60); await expire(id);
  await rows('select public.recover_expired_jobs()'); await db.query('update public.jobs set run_after = now() where id = $1', [id]);
  const fast = await claim('same-name', 60);
  assert.equal(String(fast.id), String(id));
  assert.equal(await renew(slow), false);
  assert.equal(await renew(fast), true);
});
test('jobs that are queued, done or failed cannot be renewed', async () => {
  const queued = await enqueue('q.example.com');
  assert.equal(await renew({ id: queued, locked_by: 'w1', lease_token: '00000000-0000-4000-8000-000000000000' }), false);
  for (const [status, dom] of [['done', 'x1.example.com'], ['failed', 'x2.example.com']]) {
    const id = await enqueue(dom); const token = '11111111-1111-4111-8111-111111111111';
    await db.query(`update public.jobs set status = $2, locked_by = 'w1', lease_token = $3, lease_expires_at = now() + interval '1 hour' where id = $1`, [id, status, token]);
    assert.equal(await renew({ id, locked_by: 'w1', lease_token: token }), false, status);
  }
});
test('nonsense lease lengths are rejected', async () => {
  const id = await enqueue(); const j = await claim('w1');
  for (const secs of [0, -5, 3601]) await assert.rejects(db.query('select public.renew_job_lease($1, $2, $3, $4)', [id, 'w1', j.lease_token, secs]), /bad lease length/, String(secs));
});
test('server-only', async () => {
  const sql = `select public.renew_job_lease(1, 'w', '00000000-0000-4000-8000-000000000000'::uuid, 60)`;
  await asUser(db, U1, async () => { await assert.rejects(db.query(sql), /permission denied/); });
  await as(db, 'anon', null, async () => { await assert.rejects(db.query(sql), /permission denied/); });
  await as(db, 'service_role', null, async () => { await db.query(sql); });
});

// ---- end to end: runWithLease + the real functions ----
test('a job that runs longer than its lease is NOT recovered while it keeps renewing', async () => {
  const id = await enqueue(); const j = await q.claim(sb, 'w1', 2);
  let recovered = 0; let polling = true;
  const poller = (async () => { while (polling) { recovered += Number((await rows('select public.recover_expired_jobs() as n'))[0].n); await new Promise((r) => setTimeout(r, 120)); } })();
  const result = await q.runWithLease(sb, j, async (lease) => { await new Promise((r) => setTimeout(r, 3600)); lease.assertHeld(); return 'finished'; }, { worker: 'w1', leaseSeconds: 2, everyMs: 250, marginMs: 100 });
  polling = false; await poller;
  assert.equal(result, 'finished'); assert.equal(recovered, 0, 'the lease was kept alive');
  assert.equal(await q.complete(sb, j, 'w1'), true);
  assert.equal((await job(id)).status, 'done');
});
test('control: without renewal the same job IS recovered once its lease ends', async () => {
  const id = await enqueue(); await claim('w1', 1);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(Number((await rows('select public.recover_expired_jobs() as n'))[0].n), 1);
  assert.equal((await job(id)).status, 'queued');
});
test('ownership changes mid-job under the SAME worker name: the old execution is stopped, cannot write or complete, and the new one is untouched', async () => {
  const id = await enqueue(); const old = await q.claim(sb, 'shared', 2);
  const writes = [];
  const outcome = q.runWithLease(sb, old, async (lease) => {
    await new Promise((r) => setTimeout(r, 1200));
    lease.assertHeld(); writes.push('write by the old execution'); // must not be reached
  }, { worker: 'shared', leaseSeconds: 2, everyMs: 300, marginMs: 0 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 100));
  await expire(id); await rows('select public.recover_expired_jobs()');
  await db.query('update public.jobs set run_after = now() where id = $1', [id]);
  const fresh = await q.claim(sb, 'shared', 60);            // a new execution with the identical worker name
  const err = await outcome;
  assert.ok(err instanceof q.LeaseLostError); assert.deepEqual(writes, []);
  assert.equal(await q.complete(sb, old, 'shared'), false);
  assert.equal(await q.fail(sb, old, new Error('late'), 'shared'), null);
  const final = await job(id);
  assert.equal(final.status, 'running'); assert.equal(final.lease_token, fresh.lease_token);
  assert.equal(await q.complete(sb, fresh, 'shared'), true);
});
test('the wrapper refuses to act without a token instead of sending a request that could never work', async () => {
  await assert.rejects(q.complete(sb, { id: 1 }, 'w'), /no lease token/);
  await assert.rejects(q.fail(sb, { id: 1 }, new Error('x'), 'w'), /no lease token/);
  await assert.rejects(q.renewLease(sb, { id: 1 }, 'w', 60), /no lease token/);
});
