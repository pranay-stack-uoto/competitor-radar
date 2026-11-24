// Migration 0025: Google Maps listings (job_write_maps) and the share-of-voice column.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, asUser, asSupabase, seedTwoTenants, U1, U2 } from '../helpers/db.mjs';
import q from '../../lib/queue.js';

let db, sb, p1;
before(async () => { db = await createDb(); sb = asSupabase(db); ({ p1 } = await seedTwoTenants(db)); });
beforeEach(async () => { await db.exec('delete from public.jobs; delete from public.maps_results'); });
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const row = (position, extra = {}) => ({ keyword: 'glass', location: 'pune', position, domain: `s${position}.example.com`, name: `Shop ${position}`, rating: 4.5, rating_count: 20 + position, category: 'Glazier', phone: '+91 1', ...extra });

test('a worker that owns its job stores the listings; a second write for the same day replaces them', async () => {
  await db.query(`select public.enqueue_job($1, current_date, 'discover', null)`, [p1]);
  const job = await q.claim(sb, 'w', 300);
  await q.runWithLease(sb, job, async (lease) => {
    assert.equal(await lease.write('job_write_maps', { p_rows: [row(1), row(2), row(1, { keyword: '__brand__', location: 'Acme', domain: '' })] }), true);
    assert.equal(await lease.write('job_write_maps', { p_rows: [row(1)] }), true);
  }, { worker: 'w' });
  const r = await rows('select * from public.maps_results');
  assert.equal(r.length, 1); assert.equal(r[0].project_id, p1); assert.equal(Number(r[0].rating), 4.5); assert.equal(r[0].rating_count, 21);
});
test('junk is dropped, not stored: bad positions, and a bad payload is rejected', async () => {
  await db.query(`select public.enqueue_job($1, current_date, 'discover', null)`, [p1]);
  const job = await q.claim(sb, 'w', 300);
  await q.runWithLease(sb, job, async (lease) => {
    await lease.write('job_write_maps', { p_rows: [row(1), row(0), { ...row(2), position: 'x' }, row(101)] });
    await assert.rejects(lease.write('job_write_maps', { p_rows: { not: 'an array' } }), /bad payload/);
  }, { worker: 'w' });
  assert.equal((await rows('select * from public.maps_results')).length, 1);
});
test('a worker that does not own the job cannot write, and the table is closed to direct writes from the browser', async () => {
  await db.query(`select public.enqueue_job($1, current_date, 'discover', null)`, [p1]);
  const job = await q.claim(sb, 'w', 300);
  assert.equal((await rows('select public.job_write_maps($1, $2, $3, $4::jsonb) as ok', [job.id, 'someone-else', job.lease_token, JSON.stringify([row(1)])]))[0].ok, false);
  assert.equal((await rows('select * from public.maps_results')).length, 0);
  await asUser(db, U1, async () => {
    await assert.rejects(db.query(`insert into public.maps_results (project_id, day, keyword, position) values ($1, current_date, 'k', 1)`, [p1]), /permission denied/);
    await assert.rejects(db.query('select public.job_write_maps(1, $1, $2, $3::jsonb)', ['w', job.lease_token, '[]']), /permission denied/);
  });
});
test('only members of the project can read its listings', async () => {
  await db.query(`insert into public.maps_results (project_id, day, keyword, location, position, domain) values ($1, current_date, 'k', 'l', 1, 'a.com')`, [p1]);
  await asUser(db, U1, async () => assert.equal((await db.query('select * from public.maps_results')).rows.length, 1));
  await asUser(db, U2, async () => assert.equal((await db.query('select * from public.maps_results')).rows.length, 0));
});
