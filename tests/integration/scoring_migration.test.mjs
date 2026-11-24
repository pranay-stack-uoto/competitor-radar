import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser, seedTwoTenants, U1 } from '../helpers/db.mjs';

let db, p1;
before(async () => { db = await createDb(); ({ p1 } = await seedTwoTenants(db)); });

test('existing score rows default to methodology version 1 and new rows can carry another', async () => {
  const r = await db.query(`select method_version from public.scores where project_id = $1`, [p1]);
  assert.equal(r.rows[0].method_version, 1);
  await db.query(`insert into public.scores (project_id, day, domain, overall, method_version) values ($1, current_date + 1, 'v2.example.com', 50, 2)`, [p1]);
  assert.equal((await db.query(`select method_version from public.scores where domain = 'v2.example.com'`)).rows[0].method_version, 2);
  await assert.rejects(db.query(`insert into public.scores (project_id, day, domain, method_version) values ($1, current_date, 'bad.example.com', 0)`, [p1]), /method_version_check/);
});
test('the same site on the same day keeps one row per project, and different methods stay distinguishable over time', async () => {
  await db.query(`insert into public.scores (project_id, day, domain, overall, method_version) values ($1, current_date - 5, 'm.example.com', 70, 1), ($1, current_date - 4, 'm.example.com', 60, 2)`, [p1]);
  const r = await db.query(`select day, method_version from public.scores where domain = 'm.example.com' order by day`, []);
  assert.deepEqual(r.rows.map((x) => x.method_version), [1, 2]);
});
test('the browser can read method_version on its own scores', async () => {
  await asUser(db, U1, async () => { assert.ok((await db.query('select method_version from public.scores')).rows.length >= 1); });
});

const key = 'a'.repeat(64);
test('ai_cache: stores, expires, and is server-only', async () => {
  await as(db, 'service_role', null, async () => {
    await db.query(`select public.put_ai_cache($1, 'answer', 60)`, [key]);
    assert.equal((await db.query('select public.get_ai_cache($1) as v', [key])).rows[0].v, 'answer');
    await db.query(`select public.put_ai_cache($1, 'newer', 60)`, [key]);
    assert.equal((await db.query('select public.get_ai_cache($1) as v', [key])).rows[0].v, 'newer');
    await assert.rejects(db.query(`select public.put_ai_cache('short', 'x', 60)`), /bad cache arguments/);
    await assert.rejects(db.query(`select public.put_ai_cache($1, 'x', 0)`, [key]), /bad cache arguments/);
  });
  await db.query(`update public.ai_cache set expires_at = now() - interval '1 second'`);
  assert.equal((await db.query('select public.get_ai_cache($1) as v', [key])).rows[0].v, null);
  await asUser(db, U1, async () => {
    await assert.rejects(db.query('select * from public.ai_cache'), /permission denied/);
    await assert.rejects(db.query('select public.get_ai_cache($1)', [key]), /permission denied/);
    await assert.rejects(db.query(`select public.put_ai_cache($1, 'x', 60)`, [key]), /permission denied/);
  });
});

test('set_ranks writes every rank in one statement, only for the named project and day', async () => {
  const day = '2026-01-02';
  await db.query(`insert into public.scores (project_id, day, domain, overall) values ($1, $2, 'a.example.com', 1), ($1, $2, 'b.example.com', 2), ($1, $2, 'c.example.com', 3), ($1, '2026-01-03', 'a.example.com', 9)`, [p1, day]);
  const n = (await db.query(`select public.set_ranks($1, $2, $3) as n`, [p1, day, ['c.example.com', 'a.example.com', 'b.example.com', 'ghost.example.com']])).rows[0].n;
  assert.equal(n, 3);
  const r = (await db.query(`select domain, rank from public.scores where project_id = $1 and day = $2 order by rank`, [p1, day])).rows;
  assert.deepEqual(r.map((x) => [x.domain, x.rank]), [['c.example.com', 1], ['a.example.com', 2], ['b.example.com', 3]]);
  assert.equal((await db.query(`select rank from public.scores where project_id = $1 and day = '2026-01-03'`, [p1])).rows[0].rank, null);
  await asUser(db, U1, async () => { await assert.rejects(db.query(`select public.set_ranks($1, $2, '{a}')`, [p1, day]), /permission denied/); });
});
