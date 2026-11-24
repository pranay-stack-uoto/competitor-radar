// REAL-POSTGRES: budgets never overshoot and the audit hash chain stays intact when many connections write at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, setup, conn } from '../helpers/realdb.mjs';

let admin, org;
const U = '11111111-1111-4111-8111-111111111111';
before(async () => {
  if (skip) return;
  admin = await setup();
  await admin.query('insert into auth.users (id) values ($1)', [U]);
  org = (await admin.query(`insert into public.organisations (name) values ('o') returning id`)).rows[0].id;
  await admin.query(`insert into public.organisation_members values ($1, $2, 'owner')`, [org, U]);
});
after(async () => { if (admin) await admin.end(); });

test('40 simultaneous charges against a limit of 25: exactly 25 are allowed and the counter never passes the limit', { skip }, async () => {
  await admin.query(`insert into public.org_budgets values ($1, 'ai', 25)`, [org]);
  const results = await Promise.all(Array.from({ length: 40 }, async () => {
    const c = await conn();
    try { return (await c.query(`select public.usage_charge($1, 'ai', 1) as r`, [org])).rows[0].r; } finally { await c.end(); }
  }));
  assert.equal(results.filter((r) => r.allowed).length, 25);
  assert.equal(results.filter((r) => !r.allowed).length, 15);
  assert.equal((await admin.query(`select amount from public.usage_daily where metric = 'ai'`)).rows[0].amount, 25);
  assert.equal(Math.max(...results.filter((r) => r.allowed).map((r) => r.used)), 25);
  assert.equal(new Set(results.filter((r) => r.allowed).map((r) => r.used)).size, 25, 'every allowed charge saw a different running total');
  assert.equal((await admin.query(`select count(*)::int as n from public.alerts where kind = 'budget_exhausted'`)).rows[0].n, 1, 'one alert, not fifteen');
  assert.equal((await admin.query(`select count(*)::int as n from public.alerts where kind = 'budget_warning'`)).rows[0].n, 1);
});

test('60 simultaneous audit writers: no gaps in the chain, no forks, and the chain verifies', { skip }, async () => {
  await Promise.all(Array.from({ length: 60 }, async (_, i) => {
    const c = await conn();
    try { await c.query(`select public.audit_record($1, null, 'load.test', 'n', $2, '{}')`, [org, String(i)]); } finally { await c.end(); }
  }));
  const rows = (await admin.query(`select id, prev_hash, hash from public.audit_log order by id`)).rows;
  assert.ok(rows.length >= 60);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash, `row ${rows[i].id} links to the row before it`);
  assert.equal(new Set(rows.map((r) => r.prev_hash)).size, rows.length, 'no two rows share a predecessor (no fork)');
  const v = (await admin.query('select * from public.audit_verify()')).rows[0];
  assert.equal(v.first_bad_id, null); assert.equal(Number(v.checked), rows.length);
});

test('membership changes made concurrently with audit writes all land in the trail', { skip }, async () => {
  const users = [];
  for (let i = 0; i < 20; i++) { const u = `${String(100 + i).padStart(8, '0')}-0000-4000-8000-000000000000`; await admin.query('insert into auth.users (id) values ($1)', [u]); users.push(u); }
  await Promise.all(users.map(async (u) => { const c = await conn(); try { await c.query(`insert into public.organisation_members values ($1, $2, 'viewer')`, [org, u]); } finally { await c.end(); } }));
  const n = (await admin.query(`select count(*)::int as n from public.audit_log where action = 'member.added'`)).rows[0].n;
  assert.ok(n >= 21, `${n} member.added rows`);
  assert.equal((await admin.query('select * from public.audit_verify()')).rows[0].first_bad_id, null);
});
