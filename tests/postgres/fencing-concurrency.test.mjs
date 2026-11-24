// REAL-POSTGRES tests of job fencing (migrations 0010 and 0012): row locks, wall-clock expiry and claim races across several connections.
// Needs TEST_DATABASE_URL (see tests/helpers/realdb.mjs). Skipped without it. Do NOT point it at the PGlite socket server: these tests
// rely on one connection waiting for another's lock, which that server cannot do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, setup, conn, sleep, settledWithin } from '../helpers/realdb.mjs';

let admin, project;
const U = '11111111-1111-4111-8111-111111111111';
before(async () => {
  if (skip) return;
  admin = await setup();
  await admin.query(`insert into auth.users (id) values ($1)`, [U]);
  project = (await admin.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'p', 'https://p.example.com', 'p.example.com') returning id`, [U])).rows[0].id;
});
after(async () => { if (admin) await admin.end(); });
const reset = () => admin.query('delete from public.jobs; delete from public.site_audits; delete from public.scores');
const enqueue = async (kind, domain = null) => (await admin.query(`select public.enqueue_job($1, current_date, $2, $3) as id`, [project, kind, domain])).rows[0].id;
const claim = async (c, worker, lease) => (await c.query('select * from public.claim_job($1, $2)', [worker, lease])).rows[0];

test('concurrent claims never produce duplicate ownership: every job has exactly one holder and a distinct token', { skip }, async () => {
  await reset();
  const N = 60;
  for (let i = 0; i < N; i++) await enqueue('crawl', `d${i}.example.com`);
  const got = [];
  await Promise.all(Array.from({ length: 12 }, async (_, n) => {
    const c = await conn();
    try { for (;;) { const j = await claim(c, 'same-name-for-all', 300); if (!j) break; got.push(j); } } finally { await c.end(); }
  }));
  assert.equal(got.length, N);
  assert.equal(new Set(got.map((j) => String(j.id))).size, N, 'no job claimed twice');
  assert.equal(new Set(got.map((j) => j.lease_token)).size, N, 'every claim got its own token, although all workers share one name');
  const { rows } = await admin.query(`select count(*) filter (where lease_token is null or status <> 'running' or attempts <> 1) as bad from public.jobs`);
  assert.equal(Number(rows[0].bad), 0);
});

test('a fenced write holds the job row: completion waits for it, then succeeds', { skip }, async () => {
  await reset(); await enqueue('audit');
  const [a, b] = [await conn(), await conn()];
  try {
    const job = await claim(a, 'w', 300);
    await a.query('begin');
    assert.equal((await a.query('select public.job_write_audit($1,$2,$3,5,$4) as r', [job.id, 'w', job.lease_token, '{}'])).rows[0].r, true);
    const completing = b.query('select public.complete_job($1,$2,$3) as r', [job.id, 'w', job.lease_token]);
    assert.equal(await settledWithin(completing, 400), 'pending', 'completion must wait for the write transaction');
    await a.query('commit');
    assert.equal((await completing).rows[0].r, true);
    assert.equal((await admin.query('select pages from public.site_audits')).rows[0].pages, 5);
  } finally { await a.end(); await b.end(); }
});

test('recovery cannot reclaim a job between the ownership check and the commit of a fenced write', { skip }, async () => {
  await reset(); await enqueue('audit');
  const [a, b] = [await conn(), await conn()];
  try {
    const old = await claim(a, 'shared', 2);
    await a.query('begin');
    assert.equal((await a.query('select public.job_write_audit($1,$2,$3,7,$4) as r', [old.id, 'shared', old.lease_token, '{}'])).rows[0].r, true);
    await sleep(2400);                                  // the lease runs out while the write transaction is still open
    const recovering = b.query('select public.recover_expired_jobs() as n');
    assert.equal(await settledWithin(recovering, 400), 'pending', 'recovery must wait for the open write');
    await a.query('commit');
    assert.equal((await recovering).rows[0].n, 1);      // only now is the job recovered
    assert.equal((await admin.query('select pages from public.site_audits')).rows[0].pages, 7, 'the committed write stands');
    await admin.query('update public.jobs set run_after = now()');
    const fresh = await claim(b, 'shared', 60);
    assert.notEqual(fresh.lease_token, old.lease_token);
    assert.equal((await a.query('select public.job_write_audit($1,$2,$3,99,$4) as r', [old.id, 'shared', old.lease_token, '{}'])).rows[0].r, false);
    assert.equal((await admin.query('select pages from public.site_audits')).rows[0].pages, 7);
  } finally { await a.end(); await b.end(); }
});

test('a write that waited for a lock past the end of its lease is refused (wall clock, not transaction start)', { skip }, async () => {
  await reset(); await enqueue('crawl', 'p.example.com');
  const [a, b] = [await conn(), await conn()];
  try {
    const job = await claim(a, 'w', 2);
    await b.query('begin');
    await b.query('select 1 from public.jobs where id = $1 for update', [job.id]);           // someone else holds the job row
    const writing = a.query('select public.job_write_score($1,$2,$3,true,1,1,1,1,1,2,$4) as r', [job.id, 'w', job.lease_token, '{}']);
    assert.equal(await settledWithin(writing, 300), 'pending');
    await sleep(2200);                                                                         // the lease ends while the write waits
    await b.query('commit');
    assert.equal((await writing).rows[0].r, false);
    assert.equal(Number((await admin.query('select count(*) as n from public.scores')).rows[0].n), 0);
  } finally { await a.end(); await b.end(); }
});

test('two stale-versus-current executions racing to write: exactly the current token wins, whatever the interleaving', { skip }, async () => {
  for (let round = 0; round < 10; round++) {
    await reset(); await enqueue('crawl', 'p.example.com');
    const [a, b] = [await conn(), await conn()];
    try {
      const old = await claim(a, 'shared', 60);
      await admin.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [old.id]);
      await admin.query('select public.recover_expired_jobs()'); await admin.query('update public.jobs set run_after = now()');
      const cur = await claim(b, 'shared', 60);
      const w = (c, j, v) => c.query('select public.job_write_score($1,$2,$3,true,$4,1,1,1,1,2,$5) as r', [j.id, 'shared', j.lease_token, v, '{}']).then((r) => r.rows[0].r);
      const [ro, rc] = await Promise.all([w(a, old, 11), w(b, cur, 22)]);
      assert.equal(ro, false, `round ${round}`); assert.equal(rc, true, `round ${round}`);
      assert.equal(Number((await admin.query('select seo from public.scores')).rows[0].seo), 22);
    } finally { await a.end(); await b.end(); }
  }
});

// A lease that ends while the caller waits for a row lock must not be extended or completed afterwards (migration 0018).
for (const [name, call] of [['renew', (c, j) => c.query('select public.renew_job_lease($1,$2,$3,60) as r', [j.id, 'w', j.lease_token])], ['complete', (c, j) => c.query('select public.complete_job($1,$2,$3) as r', [j.id, 'w', j.lease_token])]]) {
  test(`${name}: a lease that expires while the call waits behind an open fenced write is not revived`, { skip }, async () => {
    await reset(); await enqueue('audit');
    const [a, b] = [await conn(), await conn()];
    try {
      const job = await claim(a, 'w', 2);
      await b.query('begin');
      assert.equal((await b.query('select public.job_write_audit($1,$2,$3,1,$4) as r', [job.id, 'w', job.lease_token, '{}'])).rows[0].r, true); // holds the job row FOR SHARE
      const waiting = call(a, job);
      assert.equal(await settledWithin(waiting, 300), 'pending');
      await sleep(2200);                                   // the lease ends while the call is blocked
      await b.query('commit');
      assert.equal((await waiting).rows[0].r, false, `${name} after expiry must be refused`);
      const row = (await admin.query('select status, lease_token from public.jobs where id = $1', [job.id])).rows[0];
      assert.equal(row.status, 'running'); assert.equal(row.lease_token, job.lease_token, 'untouched: recovery decides what happens to an expired lease');
    } finally { await a.end(); await b.end(); }
  });
}
