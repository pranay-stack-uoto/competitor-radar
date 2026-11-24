// Migration 0015: daily per-organisation budgets for crawl, AI and search spend.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser } from '../helpers/db.mjs';

const OWNER = '11111111-0000-4000-8000-000000000000', MEMBER = '22222222-0000-4000-8000-000000000000';
const ORG = 'a0000000-0000-4000-8000-000000000001', ORG2 = 'a0000000-0000-4000-8000-000000000002';
let db;
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const charge = async (org, metric, n = 1) => (await rows('select public.usage_charge($1, $2, $3) as r', [org, metric, n]))[0].r;
before(async () => {
  db = await createDb();
  for (const u of [OWNER, MEMBER]) await db.query('insert into auth.users (id) values ($1)', [u]);
  await db.query(`insert into public.organisations (id, name) values ($1, 'A'), ($2, 'B')`, [ORG, ORG2]);
  await db.query(`insert into public.organisation_members values ($1, $2, 'owner'), ($1, $3, 'member')`, [ORG, OWNER, MEMBER]);
});
beforeEach(async () => { await db.exec('delete from public.usage_daily; delete from public.org_budgets; delete from public.alerts'); });

test('charges are allowed up to the limit and refused beyond it; a refused charge changes nothing', async () => {
  await db.query(`insert into public.org_budgets values ($1, 'ai', 5)`, [ORG]);
  for (let i = 1; i <= 5; i++) { const r = await charge(ORG, 'ai'); assert.equal(r.allowed, true); assert.equal(r.used, i); }
  const over = await charge(ORG, 'ai');
  assert.equal(over.allowed, false); assert.equal(over.used, 5); assert.equal(over.limit, 5);
  assert.equal((await rows(`select amount from public.usage_daily where metric = 'ai'`))[0].amount, 5);
});
test('a charge larger than the room left is refused whole, not partly applied', async () => {
  await db.query(`insert into public.org_budgets values ($1, 'search', 10)`, [ORG]);
  assert.equal((await charge(ORG, 'search', 8)).allowed, true);
  assert.equal((await charge(ORG, 'search', 5)).allowed, false);
  assert.equal((await charge(ORG, 'search', 2)).allowed, true);
  assert.equal((await charge(ORG, 'search', 11)).allowed, false, 'bigger than the whole limit, even on an empty day');
});
test('organisations and metrics are counted separately', async () => {
  await db.query(`insert into public.org_budgets values ($1, 'crawl', 1), ($2, 'crawl', 1)`, [ORG, ORG2]);
  assert.equal((await charge(ORG, 'crawl')).allowed, true);
  assert.equal((await charge(ORG, 'crawl')).allowed, false);
  assert.equal((await charge(ORG2, 'crawl')).allowed, true, 'another organisation has its own budget');
  assert.equal((await charge(ORG, 'ai')).allowed, true, 'another metric has its own budget');
});
test('defaults apply without any configuration, and a limit of zero blocks everything', async () => {
  const r = await charge(ORG, 'crawl');
  assert.equal(r.limit, 300); assert.equal((await charge(ORG, 'ai')).limit, 200); assert.equal((await charge(ORG, 'search')).limit, 2000);
  await db.query(`insert into public.org_budgets values ($1, 'ai', 0)`, [ORG2]);
  assert.equal((await charge(ORG2, 'ai')).allowed, false);
});
test('crossing 80% raises one warning, reaching the limit raises one exhausted alert, each once per day', async () => {
  await db.query(`insert into public.org_budgets values ($1, 'ai', 10)`, [ORG]);
  for (let i = 0; i < 7; i++) await charge(ORG, 'ai');
  assert.equal((await rows(`select * from public.alerts where kind = 'budget_warning'`)).length, 0);
  await charge(ORG, 'ai');                       // 8 of 10
  await charge(ORG, 'ai'); await charge(ORG, 'ai'); // 10 of 10
  assert.equal((await rows(`select * from public.alerts where kind = 'budget_warning'`)).length, 1);
  for (let i = 0; i < 3; i++) await charge(ORG, 'ai'); // refused
  const ex = await rows(`select * from public.alerts where kind = 'budget_exhausted'`);
  assert.equal(ex.length, 1); assert.equal(ex[0].subject, 'ai'); assert.equal(ex[0].detail.limit, 10);
});
test('a jump straight past 80% still warns', async () => {
  await db.query(`insert into public.org_budgets values ($1, 'search', 100)`, [ORG]);
  await charge(ORG, 'search', 90);
  assert.equal((await rows(`select * from public.alerts where kind = 'budget_warning'`)).length, 1);
});
test('bad input is rejected', async () => {
  await assert.rejects(charge(ORG, 'gold'), /unknown metric/);
  await assert.rejects(charge(ORG, 'ai', 0), /bad amount/);
  await assert.rejects(charge(ORG, 'ai', 1001), /bad amount/);
  await assert.rejects(charge(null, 'ai'), /organisation required/);
});
test('the budget tables and the charge function are server-only; owners and admins can read their own usage', async () => {
  await charge(ORG, 'ai', 3); await charge(ORG2, 'ai', 4);
  await asUser(db, OWNER, async () => {
    await assert.rejects(db.query(`select public.usage_charge($1, 'ai', 1)`, [ORG]), /permission denied/);
    await assert.rejects(db.query(`insert into public.org_budgets values ($1, 'ai', 99999)`, [ORG]), /permission denied/);
    await assert.rejects(db.query(`update public.usage_daily set amount = 0`), /permission denied/);
    const u = (await db.query('select organisation_id, amount from public.usage_daily')).rows;
    assert.deepEqual(u.map((x) => [x.organisation_id, x.amount]), [[ORG, 3]], 'only their own organisation');
  });
  await asUser(db, MEMBER, async () => { assert.equal((await db.query('select * from public.usage_daily')).rows.length, 0); });
  await as(db, 'anon', null, async () => { await assert.rejects(db.query('select 1 from public.usage_daily'), /permission denied/); });
});
