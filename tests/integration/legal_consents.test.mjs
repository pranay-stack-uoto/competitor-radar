// Migration 0023: the record of who accepted which version of the Terms and Privacy Policy.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, asUser } from '../helpers/db.mjs';

const A = '11111111-0000-4000-8000-000000000000', B = '22222222-0000-4000-8000-000000000000';
let db;
before(async () => { db = await createDb(); for (const u of [A, B]) await db.query('insert into auth.users (id) values ($1)', [u]); });

test('a person records their own acceptance; the user id and the time come from the database', async () => {
  await asUser(db, A, async () => {
    await db.query(`insert into public.legal_consents (doc, version) values ('terms', '2026-11-10'), ('privacy', '2026-11-10')`);
    const r = (await db.query('select user_id, doc, accepted_at > now() - interval \'1 minute\' as fresh from public.legal_consents order by doc')).rows;
    assert.deepEqual(r.map((x) => [x.user_id, x.doc, x.fresh]), [[A, 'privacy', true], [A, 'terms', true]]);
  });
});
test('nobody can record, read, change or delete someone else\'s acceptance, or choose the time', async () => {
  await asUser(db, B, async () => {
    assert.equal((await db.query('select * from public.legal_consents')).rows.length, 0, 'B sees nothing of A');
    await assert.rejects(db.query(`insert into public.legal_consents (user_id, doc, version) values ($1, 'terms', '2026-11-11')`, [A]), /permission denied|row-level security/);
    await assert.rejects(db.query(`insert into public.legal_consents (doc, version, accepted_at) values ('terms', '2026-11-11', '2020-01-01')`), /permission denied/);
    await assert.rejects(db.query(`update public.legal_consents set version = '2026-01-01'`), /permission denied/);
    await assert.rejects(db.query(`delete from public.legal_consents`), /permission denied/);
  });
  await asUser(db, A, async () => {
    await assert.rejects(db.query(`delete from public.legal_consents`), /permission denied/);
  });
});
test('only the two documents and a date-shaped version are accepted', async () => {
  await asUser(db, B, async () => {
    await assert.rejects(db.query(`insert into public.legal_consents (doc, version) values ('cookies', '2026-11-10')`), /check|violates/);
    await assert.rejects(db.query(`insert into public.legal_consents (doc, version) values ('terms', 'latest')`), /check|violates/);
  });
});
