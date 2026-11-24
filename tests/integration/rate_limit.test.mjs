import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser, U1 } from '../helpers/db.mjs';

let db;
before(async () => { db = await createDb(); });
const hit = async (key, win, max) => (await db.query('select public.rate_limit_hit($1, $2, $3) as ok', [key, win, max])).rows[0].ok;

test('allows up to the cap, then refuses', async () => {
  const r = [];
  for (let i = 0; i < 5; i++) r.push(await hit('extract:u1', 3600, 3));
  assert.deepEqual(r, [true, true, true, false, false]);
});
test('keys are independent', async () => {
  for (let i = 0; i < 4; i++) await hit('verify:a', 3600, 2);
  assert.equal(await hit('verify:b', 3600, 2), true);
});
test('a new window starts a fresh count', async () => {
  await db.query(`insert into public.rate_limits (key, window_start, hits) values ('old:k', now() - interval '3 hours', 99)`);
  assert.equal(await hit('old:k', 3600, 5), true);
});
test('rejects nonsense arguments', async () => {
  await assert.rejects(db.query('select public.rate_limit_hit($1, 0, 5)', ['k']), /bad rate limit/);
  await assert.rejects(db.query('select public.rate_limit_hit($1, 60, -1)', ['k']), /bad rate limit/);
  await assert.rejects(db.query('select public.rate_limit_hit($1, 60, 5)', ['x'.repeat(201)]), /bad rate limit/);
});
test('only the server may use it: signed-in users and anon cannot call it or read the table', async () => {
  await asUser(db, U1, async () => {
    await assert.rejects(db.query(`select public.rate_limit_hit('k', 60, 5)`), /permission denied/);
    await assert.rejects(db.query('select * from public.rate_limits'), /permission denied/);
  });
  await as(db, 'anon', null, async () => { await assert.rejects(db.query(`select public.rate_limit_hit('k', 60, 5)`), /permission denied/); });
  await as(db, 'service_role', null, async () => { assert.equal((await db.query(`select public.rate_limit_hit('svc', 60, 5) as ok`)).rows[0].ok, true); });
});
test('many calls in a row are counted exactly (atomic upsert)', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => hit('burst', 3600, 10)));
  assert.equal(results.filter(Boolean).length, 10);
});
