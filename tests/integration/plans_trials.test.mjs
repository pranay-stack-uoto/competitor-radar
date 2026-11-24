// Migration 0021: plans and free trials.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, asUser } from '../helpers/db.mjs';

const OWNER = '11111111-0000-4000-8000-000000000000';
const ORG = 'a0000000-0000-4000-8000-000000000001', ORG2 = 'a0000000-0000-4000-8000-000000000002';
let db;
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const run = async (org) => (await rows('select public.entitlement_charge_run($1) as r', [org]))[0].r;
before(async () => {
  db = await createDb();
  await db.query('insert into auth.users (id) values ($1)', [OWNER]);
});
beforeEach(async () => {
  await db.exec('delete from public.organisation_members; delete from public.organisations');
  await db.query(`insert into public.organisations (id, name) values ($1, 'A'), ($2, 'B')`, [ORG, ORG2]);
  await db.query(`insert into public.organisation_members values ($1, $2, 'owner')`, [ORG, OWNER]);
});

test('a new organisation starts on a trial of 10 runs and 14 days', async () => {
  const [o] = await rows('select plan, trial_runs_limit, trial_runs_used, trial_ends_at > now() + interval \'13 days\' as days_ok from public.organisations where id = $1', [ORG]);
  assert.deepEqual(o, { plan: 'trial', trial_runs_limit: 10, trial_runs_used: 0, days_ok: true });
});
test('runs are counted and the one after the limit is refused without changing anything', async () => {
  await db.query('update public.organisations set trial_runs_limit = 3 where id = $1', [ORG]);
  for (let i = 1; i <= 3; i++) { const r = await run(ORG); assert.equal(r.allowed, true); assert.equal(r.used, i); assert.equal(r.runs_left, 3 - i); }
  const over = await run(ORG);
  assert.equal(over.allowed, false); assert.equal(over.reason, 'trial-runs-used');
  assert.equal((await rows('select trial_runs_used from public.organisations where id = $1', [ORG]))[0].trial_runs_used, 3);
});
test('an expired trial is refused even with runs left, and organisations are counted separately', async () => {
  await db.query(`update public.organisations set trial_ends_at = now() - interval '1 minute' where id = $1`, [ORG]);
  assert.equal((await run(ORG)).reason, 'trial-ended');
  assert.equal((await run(ORG2)).allowed, true, 'another organisation has its own trial');
});
test('paid plans are unlimited until their end date; internal is unlimited; cancelled and past_due are refused', async () => {
  await db.query(`update public.organisations set plan = 'active', plan_until = now() + interval '30 days', trial_runs_limit = 0 where id = $1`, [ORG]);
  for (let i = 0; i < 3; i++) assert.equal((await run(ORG)).allowed, true);
  await db.query(`update public.organisations set plan_until = now() - interval '1 second' where id = $1`, [ORG]);
  assert.equal((await run(ORG)).reason, 'plan-expired');
  await db.query(`update public.organisations set plan = 'internal' where id = $1`, [ORG]);
  assert.equal((await run(ORG)).allowed, true);
  for (const p of ['cancelled', 'past_due']) { await db.query('update public.organisations set plan = $2 where id = $1', [ORG, p]); assert.equal((await run(ORG)).reason, 'plan-inactive'); }
});
test('org_set_plan switches plans, can extend a trial, and rejects unknown plans and organisations', async () => {
  const r = (await rows(`select public.org_set_plan($1, 'active', now() + interval '1 year') as r`, [ORG]))[0].r;
  assert.equal(r.plan, 'active');
  const t = (await rows(`select public.org_set_plan($1, 'trial', null, 25, 30) as r`, [ORG]))[0].r;
  assert.equal(t.plan, 'trial'); assert.equal(t.trial_runs_limit, 25); assert.equal(t.plan_until, null);
  await assert.rejects(db.query(`select public.org_set_plan($1, 'gold')`, [ORG]), /unknown plan/);
  await assert.rejects(db.query(`select public.org_set_plan('a0000000-0000-4000-8000-0000000000ff', 'active')`), /unknown organisation/);
});
test('the browser cannot spend runs, change plans, or edit the plan columns; members can read the plan', async () => {
  await asUser(db, OWNER, async () => {
    await assert.rejects(db.query('select public.entitlement_charge_run($1)', [ORG]), /permission denied/);
    await assert.rejects(db.query(`select public.org_set_plan($1, 'active')`, [ORG]), /permission denied/);
    await assert.rejects(db.query(`update public.organisations set plan = 'active' where id = $1`, [ORG]), /permission denied/);
    await assert.rejects(db.query(`update public.organisations set trial_runs_used = 0 where id = $1`, [ORG]), /permission denied/);
    assert.equal((await db.query('select plan from public.organisations where id = $1', [ORG])).rows[0].plan, 'trial');
  });
});
