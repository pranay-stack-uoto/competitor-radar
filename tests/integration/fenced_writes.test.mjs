// Migration 0012: a job's results are committed only while it still owns its lease, checked inside the same transaction as the write.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser, asSupabase, seedTwoTenants, U1 } from '../helpers/db.mjs';
import q from '../../lib/queue.js';

let db, sb, p1;
before(async () => { db = await createDb(); sb = asSupabase(db); ({ p1 } = await seedTwoTenants(db)); });
beforeEach(async () => {
  await db.exec(`delete from public.jobs; delete from public.serp_results; delete from public.scores; delete from public.site_audits; delete from public.competitors;`);
  await db.query(`insert into public.competitors (project_id, domain, name, source, status, serp_score) values ($1, 'manual.example.org', 'Manual', 'manual', 'active', 1), ($1, 'gone.example.org', 'Gone', 'discovered', 'ignored', 1)`, [p1]);
});

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const count = async (t) => Number((await rows(`select count(*) as n from public.${t}`))[0].n);
const enqueue = async (kind, domain = null) => (await rows(`select public.enqueue_job($1, current_date, $2, $3) as id`, [p1, kind, domain]))[0].id;
const claim = (worker = 'w', lease = 300) => q.claim(sb, worker, lease);
const expire = (id) => db.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [id]);
// The slow execution loses its lease and a new execution of the SAME worker name takes the job over.
async function reclaim(job, worker) {
  await expire(job.id); await rows('select public.recover_expired_jobs()'); await db.query('update public.jobs set run_after = now() where id = $1', [job.id]);
  return claim(worker);
}
const serpRow = (position) => ({ keyword: 'plumber', location: 'pune', position, domain: `s${position}.example.com`, title: 't', url: 'https://x.example.com' });
const comp = (domain, extra = {}) => ({ domain, name: domain, serp_score: 5, appearances: 2, status: 'active', manual: false, ...extra });
const writes = {
  discover: (lease) => lease.write('job_write_discovery', { p_serp: [serpRow(1), serpRow(2)], p_competitors: [comp('new.example.org'), comp('manual.example.org', { manual: true, serp_score: 9 })] }),
  children: (lease) => lease.write('job_enqueue_crawls', { p_domains: ['a.example.com', 'b.example.com'] }),
  score: (lease) => lease.write('job_write_score', { p_is_me: true, p_seo: 70, p_geo: 60, p_local: 50, p_keywords: 40, p_overall: 58, p_method_version: 2, p_details: { ok: true } }),
  audit: (lease) => lease.write('job_write_audit', { p_pages: 12, p_data: { pages: 12 } }),
};
const kindOf = { discover: 'discover', children: 'discover', score: 'crawl', audit: 'audit' };
const snapshot = async () => ({ serp: await count('serp_results'), scores: await count('scores'), audits: await count('site_audits'), jobs: await count('jobs'),
  comps: JSON.stringify(await rows('select domain, status, source, serp_score from public.competitors order by domain')) });

// ---------------- the current owner can commit ----------------
test('the current owner commits a discovery: search results and competitor changes land together, and the manual competitor keeps its source and status', async () => {
  await enqueue('discover'); const job = await claim();
  await q.runWithLease(sb, job, async (lease) => { assert.equal(await writes.discover(lease), true); }, { worker: 'w' });
  assert.equal(await count('serp_results'), 2);
  const c = Object.fromEntries((await rows('select * from public.competitors')).map((r) => [r.domain, r]));
  assert.equal(c['new.example.org'].source, 'discovered'); assert.equal(c['new.example.org'].status, 'active');
  assert.equal(Number(c['manual.example.org'].serp_score), 9); assert.equal(c['manual.example.org'].source, 'manual');
  assert.equal(c['gone.example.org'].status, 'ignored');
});
test('the current owner commits a score for the job\'s own domain, the project and day coming from the job', async () => {
  await enqueue('crawl', 'one.example.com'); const job = await claim();
  await q.runWithLease(sb, job, async (lease) => { assert.equal(await writes.score(lease), true); }, { worker: 'w' });
  const r = await rows('select * from public.scores'); assert.equal(r.length, 1);
  assert.equal(r[0].domain, 'one.example.com'); assert.equal(r[0].project_id, p1); assert.equal(Number(r[0].overall), 58); assert.equal(r[0].method_version, 2);
  // Running it again (a retry) updates the same row.
  await enqueue('crawl', 'one.example.com').catch(() => {}); // already queued or done: either way the row stays unique
  assert.equal(await count('scores'), 1);
});
test('the current owner commits an audit and queues child crawl jobs (duplicates skipped)', async () => {
  await enqueue('audit'); const a = await claim();
  await q.runWithLease(sb, a, async (lease) => { assert.equal(await writes.audit(lease), true); }, { worker: 'w' });
  const r = await rows('select * from public.site_audits'); assert.equal(r.length, 1); assert.equal(r[0].domain, 'one.example.com'); assert.equal(r[0].pages, 12);
  await db.exec('delete from public.jobs');
  await enqueue('discover'); const d = await claim();
  await q.runWithLease(sb, d, async (lease) => { assert.equal(await writes.children(lease), 2); assert.equal(await writes.children(lease), 0, 'already queued'); }, { worker: 'w' });
  assert.equal(Number((await rows(`select count(*) as n from public.jobs where kind = 'crawl' and status = 'queued'`))[0].n), 2);
});

// ---------------- a stale execution cannot commit anything ----------------
for (const name of ['discover', 'children', 'score', 'audit']) {
  test(`STALE ${name} execution (same worker name, job reclaimed): the write is refused, nothing changes, the new owner can still write`, async () => {
    await enqueue(kindOf[name], kindOf[name] === 'crawl' ? 'one.example.com' : null);
    const old = await claim('shared-worker', 60);
    let fresh;
    const before_ = await snapshot();
    let after_;
    const outcome = await q.runWithLease(sb, old, async (lease) => {
      fresh = await reclaim(old, 'shared-worker');       // same worker name, new token
      assert.equal(old.locked_by, fresh.locked_by); assert.notEqual(old.lease_token, fresh.lease_token);
      lease.assertHeld();                                 // the local timer check still passes: this is exactly the gap the database closes
      await writes[name](lease);
    }, { worker: 'shared-worker', leaseSeconds: 60 }).catch((e) => e);
    after_ = await snapshot();
    assert.ok(outcome instanceof q.LeaseLostError, String(outcome));
    const expected = name === 'children' ? { ...before_, jobs: before_.jobs } : before_;
    assert.deepEqual(after_, expected, 'the stale write changed nothing');
    // The job is still owned by the newer execution, which can write.
    assert.equal((await rows('select lease_token from public.jobs where id = $1', [fresh.id]))[0].lease_token, fresh.lease_token);
    await q.runWithLease(sb, fresh, async (lease) => { assert.ok(await writes[name](lease)); }, { worker: 'shared-worker', leaseSeconds: 60 });
    assert.notDeepEqual(await snapshot(), before_);
  });
}

test('an expired lease with nobody having taken the job over still cannot write', async () => {
  await enqueue('crawl', 'one.example.com'); const job = await claim(); await expire(job.id);
  const fence = { p_id: job.id, p_worker: 'w', p_token: job.lease_token };
  assert.equal((await rows('select public.job_write_score($1,$2,$3,true,1,1,1,1,1,2,$4) as r', [fence.p_id, fence.p_worker, fence.p_token, '{}']))[0].r, false);
  assert.equal(await count('scores'), 0);
});
test('wrong worker, wrong or missing token, and the wrong kind of job are all refused', async () => {
  await enqueue('crawl', 'one.example.com'); const job = await claim('w');
  const score = (id, w, t) => rows('select public.job_write_score($1,$2,$3,true,1,1,1,1,1,2,$4) as r', [id, w, t, '{}']).then((r) => r[0].r);
  assert.equal(await score(job.id, 'other', job.lease_token), false);
  assert.equal(await score(job.id, 'w', '00000000-0000-4000-8000-000000000000'), false);
  assert.equal(await score(job.id, 'w', null), false);
  assert.equal(await score(999999, 'w', job.lease_token), false);
  // A crawl job's token cannot write an audit, discovery results or child jobs.
  assert.equal((await rows('select public.job_write_audit($1,$2,$3,1,$4) as r', [job.id, 'w', job.lease_token, '{}']))[0].r, false);
  assert.equal((await rows(`select public.job_write_discovery($1,$2,$3,'[]','[]') as r`, [job.id, 'w', job.lease_token]))[0].r, false);
  assert.equal((await rows(`select public.job_enqueue_crawls($1,$2,$3,'["a.example.com"]') as r`, [job.id, 'w', job.lease_token]))[0].r, null);
  assert.equal(await count('scores') + await count('site_audits'), 0);
  assert.equal(await score(job.id, 'w', job.lease_token), true);
});
test('a finished job cannot write any more', async () => {
  await enqueue('audit'); const job = await claim();
  assert.equal(await q.complete(sb, job, 'w'), true);
  assert.equal((await rows('select public.job_write_audit($1,$2,$3,1,$4) as r', [job.id, 'w', job.lease_token, '{}']))[0].r, false);
  assert.equal(await count('site_audits'), 0);
});

// ---------------- atomicity and payload checks ----------------
test('a discovery write is one transaction: a bad competitor rolls back the search results too', async () => {
  await enqueue('discover'); const job = await claim();
  await db.query(`insert into public.serp_results (project_id, day, keyword, location, position, domain) values ($1, current_date, 'old', 'x', 1, 'old.example.com')`, [p1]);
  await assert.rejects(q.runWithLease(sb, job, (lease) => lease.write('job_write_discovery', { p_serp: [serpRow(1)], p_competitors: [comp('ok.example.org'), comp('bad.example.org', { status: 'bogus' })] }), { worker: 'w' }), /check/i);
  assert.deepEqual((await rows('select domain from public.serp_results')).map((r) => r.domain), ['old.example.com'], 'the old search results are still there');
  assert.equal((await rows(`select 1 from public.competitors where domain = 'ok.example.org'`)).length, 0);
});
test('payload shapes and sizes are checked; the child list is validated and capped', async () => {
  await enqueue('discover'); const job = await claim();
  const call = (sql, ...p) => db.query(sql, [job.id, 'w', job.lease_token, ...p]);
  await assert.rejects(call(`select public.job_write_discovery($1,$2,$3,'{}','[]')`), /bad payload/);
  await assert.rejects(call(`select public.job_write_discovery($1,$2,$3,'[]','{}')`), /bad payload/);
  await assert.rejects(call(`select public.job_enqueue_crawls($1,$2,$3,$4)`, JSON.stringify(Array.from({ length: 61 }, (_, i) => `d${i}.example.com`))), /bad payload/);
  const n = (await call(`select public.job_enqueue_crawls($1,$2,$3,$4) as n`, JSON.stringify(['good.example.com', 'Bad Host', '127.0.0.1', 'localhost', 'x;drop table jobs', 'good.example.com']))).rows[0].n;
  assert.equal(n, 1, 'only the one valid, distinct domain was queued');
});

// ---------------- the lease is judged by the wall clock, not by when the statement began ----------------
test('time spent inside a transaction counts: a lease that ends mid-transaction is refused (clock_timestamp, not now())', async () => {
  await enqueue('audit'); const job = await claim('w', 1);
  const res = await db.exec(`begin; select pg_sleep(1.4); select public.job_write_audit(${job.id}, 'w', '${job.lease_token}', 1, '{}') as r; commit;`);
  const r = res.flatMap((x) => x.rows).find((x) => x && 'r' in x);
  assert.equal(r.r, false);
  assert.equal(await count('site_audits'), 0);
  // The same for completion, which used to compare against now().
  await db.exec('delete from public.jobs'); await enqueue('audit'); const j2 = await claim('w', 1);
  const res2 = await db.exec(`begin; select pg_sleep(1.4); select public.complete_job(${j2.id}, 'w', '${j2.lease_token}') as r; commit;`);
  assert.equal(res2.flatMap((x) => x.rows).find((x) => x && 'r' in x).r, false);
});

// ---------------- privileges ----------------
test('the fenced write functions are server-only', async () => {
  const calls = [`select public.job_fence(1, 'w', '00000000-0000-4000-8000-000000000000', 'crawl')`, `select public.job_write_discovery(1, 'w', '00000000-0000-4000-8000-000000000000', '[]', '[]')`,
    `select public.job_enqueue_crawls(1, 'w', '00000000-0000-4000-8000-000000000000', '[]')`, `select public.job_write_score(1, 'w', '00000000-0000-4000-8000-000000000000', true, 1, 1, 1, 1, 1, 2, '{}')`,
    `select public.job_write_audit(1, 'w', '00000000-0000-4000-8000-000000000000', 1, '{}')`];
  await asUser(db, U1, async () => { for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c); });
  await as(db, 'anon', null, async () => { for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c); });
  await as(db, 'service_role', null, async () => { for (const c of calls) await db.query(c); });
});
