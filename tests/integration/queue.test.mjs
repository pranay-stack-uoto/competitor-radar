// The Postgres job queue: atomic claiming, lease tokens, recovery, retries with backoff, fencing and de-duplication.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, as, asUser, seedTwoTenants, U1, MIGRATIONS_DIR } from '../helpers/db.mjs';

let db, p1, p2;
before(async () => { db = await createDb(); ({ p1, p2 } = await seedTwoTenants(db)); });
beforeEach(async () => { await db.exec('delete from public.jobs'); });

const q = async (sql, params) => (await db.query(sql, params)).rows;
const enqueue = async (kind = 'crawl', domain = 'a.example.com', project = p1, extra = '') =>
  (await q(`select public.enqueue_job($1, current_date, $2, $3 ${extra}) as id`, [project, kind, domain]))[0].id;
const claim = async (worker = 'w1', lease = 300) => (await q('select * from public.claim_job($1, $2)', [worker, lease]))[0] || null;
const job = async (id) => (await q('select * from public.jobs where id = $1', [id]))[0];
const secsUntil = async (id) => Number((await q('select extract(epoch from run_after - now()) as s from public.jobs where id = $1', [id]))[0].s);
// Acting on a job as its holder: the claim result carries the worker name and the lease token.
const complete = async (j, w = j.locked_by, t = j.lease_token) => (await q('select public.complete_job($1, $2, $3) as ok', [j.id, w, t]))[0].ok;
const failJob = async (j, msg = 'x', permanent = false, w = j.locked_by, t = j.lease_token) => (await q('select public.fail_job($1, $2, $3, $4, $5) as s', [j.id, w, t, msg, permanent]))[0].s;
const renew = async (j, w = j.locked_by, t = j.lease_token, secs = 300) => (await q('select public.renew_job_lease($1, $2, $3, $4) as ok', [j.id, w, t, secs]))[0].ok;
const expireLease = (id) => db.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [id]);
const releaseBackoff = (id) => db.query('update public.jobs set run_after = now() where id = $1', [id]);

test('claim takes the oldest due job and leases it', async () => {
  const a = await enqueue('crawl', 'a.example.com'), b = await enqueue('crawl', 'b.example.com');
  const j = await claim('w1');
  assert.equal(String(j.id), String(a));
  assert.equal(j.status, 'running'); assert.equal(j.attempts, 1); assert.equal(j.locked_by, 'w1');
  assert.ok(j.started_at); assert.ok(j.lease_expires_at); assert.equal(j.finished_at, null);
  assert.equal(String((await claim('w2')).id), String(b));
  assert.equal(await claim('w3'), null);
});

test('the same job is never handed to two workers', async () => {
  for (let i = 0; i < 10; i++) await enqueue('crawl', `d${i}.example.com`);
  const got = await Promise.all(Array.from({ length: 15 }, (_, i) => claim('w' + i)));
  const ids = got.filter(Boolean).map((j) => String(j.id));
  assert.equal(ids.length, 10); assert.equal(new Set(ids).size, 10);
});

test('claiming is a single statement using FOR UPDATE SKIP LOCKED (so it is safe across real concurrent connections)', () => {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, '0010_job_lease_tokens.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('function public.claim_job'), sql.indexOf('function public.renew_job_lease'));
  assert.match(fn, /for update skip locked/i);
  assert.match(fn, /status = 'queued' and run_after <= now\(\)/i);
});

test('a job scheduled for the future is not claimed yet', async () => {
  await enqueue('crawl', 'later.example.com', p1, `, now() + interval '1 hour'`);
  assert.equal(await claim(), null);
});

// ---------------- lease tokens ----------------
test('every claim returns a fresh random token and stores it on the job', async () => {
  const id = await enqueue(); const first = await claim('w1');
  assert.match(first.lease_token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal((await job(id)).lease_token, first.lease_token);
  await failJob(first); await releaseBackoff(id);
  const second = await claim('w1');   // the same job, the same worker name
  assert.notEqual(second.lease_token, first.lease_token);
  const other = await enqueue('crawl', 'b.example.com'); const third = await claim('w1');
  assert.notEqual(third.lease_token, second.lease_token); assert.ok(other);
});

test('renew, complete and fail all need the token: none, a wrong one, or another job\'s token are refused', async () => {
  const a = await enqueue('crawl', 'a.example.com'), b = await enqueue('crawl', 'b.example.com');
  const ja = await claim('w1'), jb = await claim('w1');
  const bogus = '00000000-0000-4000-8000-000000000000';
  for (const bad of [null, bogus, jb.lease_token]) {
    assert.equal(await complete(ja, 'w1', bad), false, `complete with ${bad}`);
    assert.equal(await failJob(ja, 'x', false, 'w1', bad), null, `fail with ${bad}`);
    assert.equal(await renew(ja, 'w1', bad), false, `renew with ${bad}`);
  }
  assert.equal((await job(a)).status, 'running'); assert.equal((await job(a)).lease_token, ja.lease_token);
  assert.equal(await renew(ja), true); assert.equal(await complete(ja), true); assert.equal(await complete(jb), true);
  assert.ok(b);
});

test('STALE EXECUTION with the SAME worker name: its old token is useless after the job was recovered and claimed again', async () => {
  const id = await enqueue();
  const old = await claim('shared-worker', 60);            // execution A
  await expireLease(id);                                    // A is slow; its lease runs out
  await q('select public.recover_expired_jobs()'); await releaseBackoff(id);
  const fresh = await claim('shared-worker', 60);          // execution B, same worker identity
  assert.equal(old.locked_by, fresh.locked_by); assert.notEqual(old.lease_token, fresh.lease_token);
  assert.equal(await renew(old), false);
  assert.equal(await failJob(old, 'late failure'), null);
  assert.equal(await complete(old), false);
  const d = await job(id); assert.equal(d.status, 'running'); assert.equal(d.lease_token, fresh.lease_token); assert.equal(d.error, 'worker lease expired');
  assert.equal(await renew(fresh), true); assert.equal(await complete(fresh), true);
  assert.equal((await job(id)).status, 'done');
});

test('an expired token is refused even when nobody has taken the job over yet', async () => {
  const id = await enqueue(); const j = await claim('w1'); await expireLease(id);
  assert.equal(await renew(j), false); assert.equal(await complete(j), false); assert.equal(await failJob(j), null);
  assert.equal((await job(id)).status, 'running'); // it is recovered by the next claim, not by the expired holder
});

test('the token is cleared whenever the job is released: complete, retryable fail, permanent fail and recovery', async () => {
  const a = await enqueue('crawl', 'a.example.com'), b = await enqueue('crawl', 'b.example.com'), c = await enqueue('crawl', 'c.example.com'), d = await enqueue('crawl', 'd.example.com');
  const ja = await claim('w'), jb = await claim('w'), jc = await claim('w'), jd = await claim('w');
  await complete(ja); await failJob(jb, 'retry'); await failJob(jc, 'perm', true);
  await expireLease(d); await q('select public.recover_expired_jobs()');
  for (const id of [a, b, c, d]) { const r = await job(id); assert.equal(r.lease_token, null, `job ${id} (${r.status})`); assert.equal(r.locked_by, null); }
  assert.deepEqual([(await job(a)).status, (await job(b)).status, (await job(c)).status, (await job(d)).status], ['done', 'queued', 'failed', 'queued']);
  assert.ok(jd);
});

test('a token works once: after completing or failing, the same token cannot act again', async () => {
  const a = await enqueue('crawl', 'a.example.com'), b = await enqueue('crawl', 'b.example.com');
  const ja = await claim('w'), jb = await claim('w');
  assert.equal(await complete(ja), true);
  assert.equal(await complete(ja), false); assert.equal(await renew(ja), false); assert.equal(await failJob(ja), null);
  assert.equal(await failJob(jb, 'x', true), 'failed');
  assert.equal(await complete(jb), false); assert.equal(await failJob(jb), null);
  assert.ok(a && b);
});

test('the old three-argument-style functions are inert: they cannot act on any job', async () => {
  const id = await enqueue(); const j = await claim('w1');
  assert.equal((await q('select public.complete_job($1::bigint, $2::text) as ok', [id, 'w1']))[0].ok, false);
  assert.equal((await q('select public.fail_job($1::bigint, $2::text, $3::text) as s', [id, 'w1', 'x']))[0].s, null);
  assert.equal((await q('select public.renew_job_lease($1::bigint, $2::text, $3::int) as ok', [id, 'w1', 60]))[0].ok, false);
  assert.equal((await job(id)).status, 'running'); assert.equal(await complete(j), true);
});

test('jobs left running by code from before tokens (no token) are still recovered when their lease ends', async () => {
  const [{ id }] = await q(`insert into public.jobs (project_id, day, kind, domain, status, attempts, locked_by, lease_expires_at, updated_at) values ($1, current_date, 'crawl', 'old.example.com', 'running', 1, 'old-worker', now() - interval '1 minute', now() - interval '2 minutes') returning id`, [p1]);
  assert.equal(await complete({ id, locked_by: 'old-worker', lease_token: '00000000-0000-4000-8000-000000000000' }), false);
  assert.equal(Number((await q('select public.recover_expired_jobs() as n'))[0].n), 1);
  assert.equal((await job(id)).status, 'queued');
});

// ---------------- behaviour that must not change ----------------
test('completing a job records the finish time and frees the lease', async () => {
  const id = await enqueue(); const j = await claim('w1');
  assert.equal(await complete(j), true);
  const d = await job(id);
  assert.equal(d.status, 'done'); assert.ok(d.finished_at); assert.equal(d.locked_by, null); assert.equal(d.lease_expires_at, null);
  assert.equal(await claim(), null);
});

test('fencing by worker name still applies on top of the token', async () => {
  const id = await enqueue(); const j = await claim('w1');
  assert.equal(await complete(j, 'intruder'), false);
  assert.equal(await failJob(j, 'x', false, 'intruder'), null);
  assert.equal((await job(id)).status, 'running');
});

test('a retryable failure goes back to the queue with exponential backoff, keeping the attempt count', async () => {
  const id = await enqueue('crawl', 'r.example.com', p1, ', now(), 5');
  const expected = [30, 60, 120, 240];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const j = await claim('w1');
    assert.equal(j.attempts, attempt);
    assert.equal(await failJob(j, 'timeout'), 'queued');
    const d = await job(id);
    assert.equal(d.failure_kind, 'retryable'); assert.equal(d.locked_by, null);
    const wait = await secsUntil(id);
    assert.ok(wait > expected[attempt - 1] * 0.95 && wait < expected[attempt - 1] * 1.25, `attempt ${attempt}: waited ${wait}s, expected ~${expected[attempt - 1]}s`);
    assert.equal(await claim('w2'), null, 'not claimable until the backoff has passed');
    await releaseBackoff(id);
  }
});

test('retries are bounded: after max_attempts the job is failed as exhausted', async () => {
  const id = await enqueue('crawl', 'e.example.com', p1, ', now(), 2');
  let j = await claim('w1'); await failJob(j, 'boom'); await releaseBackoff(id);
  j = await claim('w1');
  assert.equal(await failJob(j, 'boom'), 'failed');
  const d = await job(id);
  assert.equal(d.status, 'failed'); assert.equal(d.failure_kind, 'exhausted'); assert.ok(d.finished_at);
  assert.equal(await claim(), null);
});

test('a permanent failure is failed immediately, with no retry', async () => {
  const id = await enqueue(); const j = await claim('w1');
  assert.equal(await failJob(j, 'blocked address', true), 'failed');
  const d = await job(id); assert.equal(d.failure_kind, 'permanent'); assert.equal(d.attempts, 1);
});

test('stored error text is capped', async () => {
  const id = await enqueue(); const j = await claim('w1');
  await failJob(j, 'x'.repeat(5000), true);
  assert.equal((await job(id)).error.length, 500);
});

test('a crashed worker: when its lease expires the job is recovered and can be claimed again', async () => {
  const id = await enqueue(); await claim('dead-worker', 300);
  assert.equal(await claim('w2'), null);
  await expireLease(id);
  assert.equal((await q('select public.recover_expired_jobs() as n'))[0].n, 1);
  const d = await job(id);
  assert.equal(d.status, 'queued'); assert.equal(d.failure_kind, 'retryable'); assert.equal(d.locked_by, null); assert.match(d.error, /lease expired/);
  assert.ok(await secsUntil(id) > 25);
});

test('claim_job recovers expired leases by itself, so a dead worker never blocks the queue', async () => {
  const id = await enqueue(); await claim('dead-worker');
  await db.query(`update public.jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [id]);
  await claim('w2'); await releaseBackoff(id);
  const j = await claim('w2');
  assert.equal(String(j.id), String(id)); assert.equal(j.attempts, 2); assert.equal(j.locked_by, 'w2');
});

test('a job whose lease expires with no attempts left is failed, not retried forever', async () => {
  const id = await enqueue('crawl', 'x.example.com', p1, ', now(), 1');
  await claim('dead'); await expireLease(id); await q('select public.recover_expired_jobs()');
  const d = await job(id); assert.equal(d.status, 'failed'); assert.equal(d.failure_kind, 'exhausted');
});

test('jobs left "running" by the old queue (no lease) are recovered five minutes after their last update', async () => {
  const [{ id }] = await q(`insert into public.jobs (project_id, day, kind, domain, status, attempts, updated_at) values ($1, current_date, 'crawl', 'legacy.example.com', 'running', 1, now() - interval '10 minutes') returning id`, [p1]);
  const [{ id: fresh }] = await q(`insert into public.jobs (project_id, day, kind, domain, status, attempts, updated_at) values ($1, current_date, 'crawl', 'fresh.example.com', 'running', 1, now()) returning id`, [p1]);
  assert.equal((await q('select public.recover_expired_jobs() as n'))[0].n, 1);
  assert.equal((await job(id)).status, 'queued'); assert.equal((await job(fresh)).status, 'running');
});

test('enqueue de-duplicates active jobs, but allows a new one once the first has finished', async () => {
  const a = await enqueue('crawl', 'dup.example.com'); assert.ok(a);
  assert.equal(await enqueue('crawl', 'dup.example.com'), null);
  assert.equal(await enqueue('crawl', 'DUP.example.com'), null);
  const j = await claim('w1');
  assert.equal(await enqueue('crawl', 'dup.example.com'), null);
  await complete(j);
  assert.ok(await enqueue('crawl', 'dup.example.com'));
  assert.ok(await enqueue('crawl', 'other.example.com'));
  assert.ok(await enqueue('audit', 'dup.example.com'));
  assert.ok(await enqueue('crawl', 'dup.example.com', p2));
});

test('after a permanent failure the same job can be queued again', async () => {
  await enqueue('crawl', 'f.example.com'); const j = await claim('w1');
  await failJob(j, 'bad', true);
  assert.ok(await enqueue('crawl', 'f.example.com'));
});

test('the partial unique index and claim indexes exist', async () => {
  const names = (await q(`select indexname from pg_indexes where tablename = 'jobs'`)).map((r) => r.indexname);
  for (const n of ['jobs_claim', 'jobs_lease', 'jobs_active_dedupe']) assert.ok(names.includes(n), n);
});

test('queue functions are server-only, including the inert legacy ones', async () => {
  const calls = [`select public.claim_job('x', 1)`, `select public.enqueue_job('${p1}', current_date, 'crawl')`, `select public.complete_job(1, 'x', '00000000-0000-4000-8000-000000000000'::uuid)`,
    `select public.fail_job(1, 'x', '00000000-0000-4000-8000-000000000000'::uuid, 'y')`, `select public.renew_job_lease(1, 'x', '00000000-0000-4000-8000-000000000000'::uuid, 60)`, `select public.recover_expired_jobs()`,
    `select public.complete_job(1::bigint, 'x'::text)`, `select public.fail_job(1::bigint, 'x'::text, 'y'::text)`, `select public.renew_job_lease(1::bigint, 'x'::text, 60::int)`];
  await asUser(db, U1, async () => { for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c); });
  await as(db, 'anon', null, async () => { for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c); });
  await as(db, 'service_role', null, async () => { await db.query(calls[1]); });
  await asUser(db, U1, async () => { await assert.rejects(db.query('select lease_token from public.jobs'), /permission denied/); });
});
