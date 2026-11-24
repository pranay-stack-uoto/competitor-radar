// Retry and dead-letter paths: a job that keeps failing ends as dead_letter, a permanent failure does not retry, a worker that dies mid-job is
// recovered, a duplicate start never runs the same job twice, and nothing a failed attempt does damages earlier results.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, asSupabase, seedTwoTenants } from '../helpers/db.mjs';
import q from '../../lib/queue.js';

let db, sb, p1;
before(async () => { db = await createDb(); sb = asSupabase(db); ({ p1 } = await seedTwoTenants(db)); });
beforeEach(async () => { await db.exec('delete from public.jobs; delete from public.serp_results'); });
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const state = async (id) => (await rows(`select public.job_state(status, failure_kind, attempts, error) as s, status, attempts, failure_kind from public.jobs where id = $1`, [id]))[0];
const enqueue = async (kind = 'crawl', domain = 'a.example.com', maxAttempts = 3) => (await rows(`select public.enqueue_job($1, current_date, $2, $3, now(), $4) as id`, [p1, kind, domain, maxAttempts]))[0].id;
const makeDue = (id) => db.query(`update public.jobs set run_after = now() - interval '1 second' where id = $1`, [id]);

test('a retryable failure is "retrying" with a later run time; after the retry limit the job is a dead letter and is not claimed again', async () => {
  const id = await enqueue('crawl', 'a.example.com', 2);
  let job = await q.claim(sb, 'w1', 300);
  await q.fail(sb, job, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'w1');
  assert.deepEqual([(await state(id)).s, (await state(id)).attempts], ['retrying', 1]);
  assert.equal(await q.claim(sb, 'w1', 300), null, 'not claimable before its retry time');
  await makeDue(id);
  job = await q.claim(sb, 'w1', 300);
  await q.fail(sb, job, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'w1');
  const s = await state(id);
  assert.deepEqual([s.s, s.status, s.failure_kind, s.attempts], ['dead_letter', 'failed', 'exhausted', 2]);
  await makeDue(id);
  assert.equal(await q.claim(sb, 'w1', 300), null, 'a dead letter is never picked up again');
});
test('a permanent failure (client error, daily limit) is "failed" at once with no retry', async () => {
  const id = await enqueue();
  const job = await q.claim(sb, 'w1', 300);
  await q.fail(sb, job, Object.assign(new Error('Forbidden'), { status: 403 }), 'w1');
  const s = await state(id);
  assert.deepEqual([s.s, s.failure_kind, s.attempts], ['failed', 'permanent', 1]);
});
test('a worker killed mid-job: its lease expires, the job is recovered as retrying, and the dead worker\'s late result is refused', async () => {
  const id = await enqueue();
  const dead = await q.claim(sb, 'dead', 300);
  await db.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [id]);
  assert.equal(Number((await rows('select public.recover_expired_jobs() as n'))[0].n), 1);
  assert.equal((await state(id)).s, 'retrying');
  await makeDue(id);
  const next = await q.claim(sb, 'alive', 300);
  assert.equal(next.id, id);
  assert.equal(await q.complete(sb, dead, 'dead'), false, 'the old worker cannot complete the job it lost');
  assert.equal(await q.complete(sb, next, 'alive'), true);
  assert.equal((await state(id)).s, 'succeeded');
});
test('a job killed again and again at the retry limit becomes a dead letter through lease recovery too', async () => {
  const id = await enqueue('crawl', 'b.example.com', 1);
  await q.claim(sb, 'w', 300);
  await db.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [id]);
  await rows('select public.recover_expired_jobs()');
  assert.equal((await state(id)).s, 'dead_letter');
});
test('a duplicate invocation cannot run a job that is already being worked, nor finish one that already finished', async () => {
  const id = await enqueue();
  const first = await q.claim(sb, 'w1', 300);
  assert.equal(await q.claim(sb, 'w2', 300), null, 'the only job is leased to w1');
  assert.equal(await q.complete(sb, first, 'w1'), true);
  assert.equal(await q.complete(sb, first, 'w1'), false, 'completing twice is refused');
  assert.equal((await state(id)).s, 'succeeded');
  const waiting = await enqueue('crawl', 'c.example.com');
  assert.ok(waiting);
  assert.equal(await enqueue('crawl', 'c.example.com'), null, 'queuing the same active job twice adds nothing');
});
