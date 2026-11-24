// REAL-POSTGRES tests. These need an actual Postgres server because they use several simultaneous connections, which the
// in-process test database (PGlite, one connection) cannot do. They run in CI (see .github/workflows/ci.yml) against a Postgres
// service container, and locally when TEST_DATABASE_URL points at a throw-away database. Without it they are skipped.
//
// WARNING: this creates and drops a schema called radar_test. Never point it at a database you care about.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR, migrationFiles, SUPABASE_STUB } from '../helpers/db.mjs';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'TEST_DATABASE_URL is not set';
let admin;

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: URL_ }); await admin.connect();
  await admin.query('drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;');
  await admin.query(SUPABASE_STUB);
  for (const f of migrationFiles()) await admin.query(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  await admin.query(`insert into auth.users (id) values ('11111111-1111-4111-8111-111111111111')`);
  await admin.query(`insert into public.projects (id, user_id, name, url, domain) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'p', 'https://p.example.com', 'p.example.com')`);
});
after(async () => { if (admin) await admin.end(); });

const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('many workers on separate connections never claim the same job', { skip }, async () => {
  const N = 120, WORKERS = 12;
  for (let i = 0; i < N; i++) await admin.query(`select public.enqueue_job($1, current_date, 'crawl', $2)`, [project, `d${i}.example.com`]);
  const claimed = [];
  const worker = async (n) => {
    const c = new pg.Client({ connectionString: URL_ }); await c.connect();
    try { for (;;) { const { rows } = await c.query('select id from public.claim_job($1, 300)', ['w' + n]); if (!rows.length) break; claimed.push(String(rows[0].id)); } }
    finally { await c.end(); }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, n) => worker(n)));
  assert.equal(claimed.length, N, 'every job was claimed');
  assert.equal(new Set(claimed).size, N, 'no job was claimed twice');
  const { rows } = await admin.query(`select count(*) filter (where attempts <> 1) as bad from public.jobs`);
  assert.equal(Number(rows[0].bad), 0);
});

test('concurrent enqueue of the same job creates exactly one row', { skip }, async () => {
  await admin.query('delete from public.jobs');
  const results = await Promise.all(Array.from({ length: 20 }, async () => {
    const c = new pg.Client({ connectionString: URL_ }); await c.connect();
    try { return (await c.query(`select public.enqueue_job($1, current_date, 'audit', 'same.example.com') as id`, [project])).rows[0].id; } finally { await c.end(); }
  }));
  assert.equal(results.filter((x) => x != null).length, 1);
});

test('concurrent callers for one domain: exactly one is told to crawl, and only that one gets a token', { skip }, async () => {
  await admin.query('delete from public.domain_crawls');
  const rows = await Promise.all(Array.from({ length: 15 }, async () => {
    const c = new pg.Client({ connectionString: URL_ }); await c.connect();
    try { return (await c.query(`select * from public.acquire_domain_crawl_lease('race.example.com', 'f1-p40', 3600)`)).rows[0]; } finally { await c.end(); }
  }));
  assert.equal(rows.filter((r) => r.state === 'acquired').length, 1);
  assert.equal(rows.filter((r) => r.state === 'busy').length, 14);
  assert.equal(rows.filter((r) => r.token).length, 1);
});

test('a stale crawl worker cannot overwrite a newer worker, with real connections', { skip }, async () => {
  await admin.query('delete from public.domain_crawls; delete from public.domain_crawl_snapshots');
  const conn = async () => { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); return c; };
  const [a, b] = [await conn(), await conn()];
  try {
    const tokenA = (await a.query(`select * from public.acquire_domain_crawl_lease('stale.example.com', 'f1-p40', 3600, 180)`)).rows[0].token;
    await admin.query(`update public.domain_crawls set lease_expires_at = now() - interval '1 second' where domain = 'stale.example.com'`);
    const tokenB = (await b.query(`select * from public.acquire_domain_crawl_lease('stale.example.com', 'f1-p40', 3600, 180)`)).rows[0].token;
    assert.notEqual(tokenA, tokenB);
    // Both try to finish at the same moment: only B can win, whatever the interleaving.
    const fin = (c, t, who) => c.query(`select public.finish_domain_crawl_lease('stale.example.com', 'f1-p40', $1, $2::jsonb, 1, null, 'h', 3600) as ok`, [t, JSON.stringify({ pages: [{ url: who }] })]).then((r) => r.rows[0].ok);
    const [okA, okB] = await Promise.all([fin(a, tokenA, 'A'), fin(b, tokenB, 'B')]);
    assert.equal(okA, false); assert.equal(okB, true);
    const { rows } = await admin.query(`select data from public.domain_crawls where domain = 'stale.example.com'`);
    assert.equal(rows[0].data.pages[0].url, 'B');
  } finally { await a.end(); await b.end(); }
});

test('rate limiter counts exactly under concurrent connections', { skip }, async () => {
  const hits = await Promise.all(Array.from({ length: 15 }, async () => {
    const c = new pg.Client({ connectionString: URL_ }); await c.connect();
    try { return (await c.query(`select public.rate_limit_hit('burst:pg', 3600, 10) as ok`)).rows[0].ok; } finally { await c.end(); }
  }));
  assert.equal(hits.filter(Boolean).length, 10);
  assert.equal(hits.filter((h) => !h).length, 5);
});

// Two overlapping executions that share one worker name (a restarted process, or two serverless invocations that both call themselves
// "worker-1"): the worker name alone cannot tell them apart, the lease token can.
test('two overlapping executions with the SAME worker name: only the current token can renew, complete or fail', { skip }, async () => {
  await admin.query('delete from public.jobs');
  const conn = async () => { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); return c; };
  const [a, b] = [await conn(), await conn()];
  try {
    await admin.query(`select public.enqueue_job($1, current_date, 'crawl', 'same-name.example.com')`, [project]);
    const old = (await a.query(`select * from public.claim_job('shared', 60)`)).rows[0];
    await admin.query(`update public.jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [old.id]);
    await admin.query('select public.recover_expired_jobs()');
    await admin.query('update public.jobs set run_after = now() where id = $1', [old.id]);
    const cur = (await b.query(`select * from public.claim_job('shared', 60)`)).rows[0];
    assert.equal(String(cur.id), String(old.id)); assert.notEqual(cur.lease_token, old.lease_token);
    // Everything the stale execution and the current one try at the same moment.
    const [oRenew, oDone, oFail, cRenew] = await Promise.all([
      a.query('select public.renew_job_lease($1, $2, $3, 60) as v', [old.id, 'shared', old.lease_token]),
      a.query('select public.complete_job($1, $2, $3) as v', [old.id, 'shared', old.lease_token]),
      a.query('select public.fail_job($1, $2, $3, $4, true) as v', [old.id, 'shared', old.lease_token, 'late']),
      b.query('select public.renew_job_lease($1, $2, $3, 60) as v', [cur.id, 'shared', cur.lease_token]),
    ]);
    assert.equal(oRenew.rows[0].v, false); assert.equal(oDone.rows[0].v, false); assert.equal(oFail.rows[0].v, null); assert.equal(cRenew.rows[0].v, true);
    assert.equal((await admin.query('select status, lease_token from public.jobs where id = $1', [cur.id])).rows[0].status, 'running');
    assert.equal((await b.query('select public.complete_job($1, $2, $3) as v', [cur.id, 'shared', cur.lease_token])).rows[0].v, true);
  } finally { await a.end(); await b.end(); }
});

test('racing completions with one token: exactly one succeeds', { skip }, async () => {
  await admin.query('delete from public.jobs');
  await admin.query(`select public.enqueue_job($1, current_date, 'crawl', 'twice.example.com')`, [project]);
  const j = (await admin.query(`select * from public.claim_job('w', 60)`)).rows[0];
  const oks = await Promise.all(Array.from({ length: 8 }, async () => {
    const c = new pg.Client({ connectionString: URL_ }); await c.connect();
    try { return (await c.query('select public.complete_job($1, $2, $3) as v', [j.id, 'w', j.lease_token])).rows[0].v; } finally { await c.end(); }
  }));
  assert.equal(oks.filter(Boolean).length, 1);
});
